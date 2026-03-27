# storacha-export — Design Spec

**Date:** 2026-03-27
**Status:** Draft
**Author:** Danny O'Brien + Claude

## Problem

Users need to export their data from Storacha to other storage backends. The Storacha ecosystem is Node-first, and there is no existing tool for bulk export with resumability and pluggable targets.

## Solution

`storacha-export` — a Node.js CLI tool that exports content from Storacha spaces to one or more storage backends. Streams CAR data from the Storacha gateway, fans out to pluggable backends, tracks progress in SQLite for resumability.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────────┐
│  Enumerator  │────▶│  Job Queue   │────▶│   Executor     │
│  (Storacha   │     │  (SQLite)    │     │                │
│   client)    │     │              │     │  fetch CAR ──┬─▶ backend A
│              │     │  tracks per- │     │   stream    ├─▶ backend B
│  space list  │     │  CID, per-   │     │             └─▶ backend C
│  upload list │     │  backend     │     │                │
└─────────────┘     │  status      │     └────────────────┘
                    └──────────────┘
```

### Phases

1. **Enumerate** — walk Storacha spaces, list uploads, insert into SQLite job queue
2. **Execute** — pull pending jobs, stream CAR from `w3s.link`, fan out to backends
3. **Verify** (optional) — check backends report content present

## Auth Flow

On startup:

1. Check for existing Storacha agent credentials (`~/.config/storacha/`)
2. If found, probe what account/spaces are accessible
3. Display: "Found credentials for `user@example.com` with access to N spaces. Use these? [Y/n]"
4. If not found or declined, run own `login` flow via `@storacha/client`

## Interactive Wizard

When run without command-line options (`storacha-export` with no args), present an interactive wizard using `inquirer`:

1. Credential detection / login
2. Space selection (all, or pick specific spaces)
3. Backend selection (checkboxes: local files, kubo, ipfs-cluster)
4. Backend configuration (output dir, API endpoints, etc.)
5. Concurrency setting
6. Confirm and start

When run with full CLI options, skip the wizard entirely.

## Job Queue (SQLite)

```sql
CREATE TABLE jobs (
  root_cid TEXT NOT NULL,
  space_did TEXT NOT NULL,
  space_name TEXT,
  backend TEXT NOT NULL,
  status TEXT DEFAULT 'pending',  -- pending | in_progress | done | error
  error_msg TEXT,
  bytes_transferred INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (root_cid, backend)
);

CREATE TABLE spaces (
  did TEXT PRIMARY KEY,
  name TEXT,
  total_uploads INTEGER,
  total_bytes INTEGER,
  enumerated_at TEXT
);
```

One row per (root CID, backend) pair. Re-enumeration on `--continue` merges: existing `done` rows kept, new CIDs added as `pending`.

### Resumability Without SQLite

If the DB is missing or corrupt but `--continue` is passed:

1. Re-enumerate from Storacha
2. For each CID, call `backend.hasContent(cid)` before queuing
3. Only queue CIDs not already present in any target backend

This makes the tool resilient — you can always recover from a failed state.

## Streaming Strategy

```
w3s.link/ipfs/{CID}?format=car
        │
        ▼
   ReadableStream
        │
   ┌────┴────┐  (if multiple backends)
   │  tee()  │
   ├────┬────┤
   ▼    ▼    ▼
  be1  be2  be3
```

- **Local-file backend among targets:** write to disk first, then stream from disk to remaining backends. Disk acts as cache, avoids re-download if a remote backend fails.
- **No local backend, multiple remotes:** `tee()` the HTTP response stream to all backends simultaneously.
- **Single backend:** direct pipe, no tee.

This minimizes temp storage when local files aren't a target.

## Backend Plugin Interface

```typescript
interface ExportBackend {
  name: string;

  // Can this backend check if content exists without downloading?
  hasContent(rootCid: string): Promise<boolean>;

  // Import a CAR stream. Returns when fully consumed.
  importCar(rootCid: string, stream: ReadableStream): Promise<void>;

  // Optional lifecycle hooks
  init?(): Promise<void>;
  close?(): Promise<void>;
}
```

### Included Backends (v1)

**`local-file`**
- Saves `.car` files to a directory, named `{rootCid}.car`
- `hasContent`: check if file exists on disk
- Config: `--output <dir>`

**`kubo`**
- `POST /api/v0/dag/import` to a kubo HTTP API endpoint
- `hasContent`: `POST /api/v0/pin/ls?arg={cid}&type=recursive`, check if pinned
- Config: `--kubo-api <multiaddr-or-url>`

**`ipfs-cluster`**
- `POST /add` to cluster REST API
- `hasContent`: `GET /pins/{cid}` check pin status
- Config: `--cluster-api <url>`

### Future Backends (not in v1)

- `filecoin-pin` — POST to the filecoin-pin API

## CLI Interface

```bash
# Interactive wizard (no args)
storacha-export

# Full export to local files
storacha-export --backend local --output ./cars/

# Export to kubo node
storacha-export --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export to multiple backends
storacha-export \
  --backend local --output ./cars/ \
  --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Resume interrupted export
storacha-export --continue \
  --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export specific space only
storacha-export --space "Smithsonian" \
  --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Dry run — enumerate only, show what would be exported
storacha-export --dry-run

# Adjust concurrency
storacha-export --concurrency 3 --backend kubo --kubo-api ...
```

## Concurrency & Politeness

- Default concurrency: 1 simultaneous transfer
- `--concurrency N` to adjust (recommend keeping low)
- Exponential backoff on 429 / 5xx from gateway
- Respects `Retry-After` headers

## Progress Display

**Interactive terminal (TTY):**
- `ora` spinners for enumeration phase
- `cli-progress` bars for transfer phase
- Per-space and overall progress
- Current CID, bytes transferred, transfer rate

**Non-interactive (piped/nohup):**
- Simple log lines: `[INFO] [Smithsonian] 3/27 bafybeie... 1.2GB done`
- Standard Node.js logging (respects `LOG_LEVEL` env var)
- JSON log format available via `--log-format json`

## Farewell Rooster

On successful completion, display a Storacha-themed rooster ASCII art saying goodbye. Because every good migration deserves a proper send-off.

## Project Structure

```
storacha-export/
├── package.json
├── bin/
│   └── storacha-export.js
├── src/
│   ├── cli.js           # argument parsing, wizard, main flow
│   ├── auth.js          # credential detection & login
│   ├── enumerator.js    # list spaces & uploads via @storacha/client
│   ├── queue.js         # SQLite job queue
│   ├── executor.js      # fetch CAR, stream/tee to backends
│   ├── progress.js      # TTY vs log output
│   ├── rooster.js       # farewell art
│   └── backends/
│       ├── index.js     # backend registry & factory
│       ├── local.js     # local CAR file backend
│       ├── kubo.js      # kubo API backend
│       └── cluster.js   # ipfs-cluster backend
└── test/
    ├── queue.test.js
    ├── executor.test.js
    └── backends/
        ├── local.test.js
        └── kubo.test.js
```

## Dependencies

- `@storacha/client` — Storacha API client (auth, space listing, upload listing)
- `commander` — CLI argument parsing
- `inquirer` — interactive wizard prompts
- `better-sqlite3` — SQLite for job queue (synchronous, fast, no native async overhead)
- `ora` — terminal spinners
- `cli-progress` — progress bars
- `pino` — structured logging (standard Node.js logger)

## Assumptions

- The `w3s.link` gateway will remain available during export
- CAR files served by the gateway contain the complete DAG for a given root CID
- Storacha agent credentials grant `upload/list` and `space/info` capabilities
- Target backends accept standard CARv1/v2 format

## Risks

- Gateway rate limiting under bulk export — mitigated by low default concurrency and backoff
- Large individual CARs (multi-GB) may strain Node.js stream handling — mitigated by streaming (no buffering entire CAR in memory)
- `tee()` to multiple backends means the slowest backend gates throughput — acceptable trade-off vs downloading twice
- Gateway could go down before migration completes — resumability via job queue handles this

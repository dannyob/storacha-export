# storacha-export v2 — Design Spec

**Date:** 2026-03-29
**Status:** Draft
**Author:** Danny O'Brien + Claude

## Problem

Storacha users need to be able to export their data to other storage backends. The v1 tool works but has architectural limitations discovered during production use:

- Gateway serves truncated CARs for large uploads — repair was bolted on reactively
- No block-level tracking — can't resume mid-CAR or know what's already been fetched
- Node/Web streams mismatch caused multiple bugs
- Repair buffers entire repair CAR in memory
- No verification phase to confirm exports are complete

## Solution

Clean-room TypeScript rewrite in the same repo. Same purpose, same backend model, better architecture. Built around a `BlockStream` abstraction that eliminates the streams mismatch, with block-level manifest tracking that makes repair a natural part of the download flow rather than a bolt-on.

## Core Abstraction: BlockStream

Everything produces, consumes, or transforms one type:

```typescript
type Block = { cid: CID; bytes: Uint8Array }
type BlockStream = AsyncIterable<Block>
```

- **Gateway CAR fetcher** → produces a `BlockStream` by parsing a CAR response
- **Individual block fetcher** → produces a `BlockStream` by fetching raw blocks
- **Manifest tracker** → transforms a `BlockStream`, recording CIDs in SQLite
- **Backend** → consumes a `BlockStream`

Node streams and Web streams only appear at adapter boundaries (fetch response, kubo HTTP upload). The core logic never touches them.

## Upload Lifecycle

```
pending → downloading → partial → complete
                ↓           ↓
              error      repairing → complete
                             ↓
                           error
```

**pending** — known root CID, not yet attempted.

**downloading** — CAR streaming from gateway. The manifest tracker records every block CID, codec, and dag-pb links as they flow through. On success, transitions to `complete`.

**partial** — download failed mid-stream (truncation, timeout). The manifest contains every block seen so far and all links discovered from dag-pb nodes. This is not a failure — it's progress.

**repairing** — fetching missing blocks individually. The manifest tells us exactly which blocks are still needed. Each fetched block updates the manifest. Interruption is safe — next attempt resumes from the manifest.

**complete** — all blocks present, root pinned/stored in backend.

**error** — permanent failure after configured retry limit. Distinguished from transient failures.

Key insight: `partial` is a normal state, not a failure. A 3.7 TiB upload truncated at 2 TiB has made 2 TiB of progress. Every subsequent attempt — whether a fresh CAR download or individual block fetches — adds to the manifest. Progress accumulates across attempts.

## SQLite Schema

```sql
CREATE TABLE uploads (
  root_cid TEXT NOT NULL,
  space_did TEXT NOT NULL,
  space_name TEXT,
  backend TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  attempt_count INTEGER DEFAULT 0,
  bytes_transferred INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (root_cid, backend)
);

CREATE TABLE blocks (
  root_cid TEXT NOT NULL,
  block_cid TEXT NOT NULL,
  codec INTEGER NOT NULL,       -- 0x70 = dag-pb, 0x55 = raw
  seen INTEGER DEFAULT 0,       -- 1 = received this block
  linked_by TEXT,               -- CID of dag-pb node that references this
  PRIMARY KEY (root_cid, block_cid)
);

CREATE TABLE spaces (
  did TEXT PRIMARY KEY,
  name TEXT,
  total_uploads INTEGER,
  total_bytes INTEGER,
  enumerated_at TEXT
);
```

The `blocks` table is only populated for uploads that need repair, not for successful first-attempt downloads. For a truncated upload, it stores the full manifest: blocks we've seen (`seen=1`) and blocks we know about from dag-pb links but haven't received (`seen=0`).

Repair query: `SELECT block_cid FROM blocks WHERE root_cid = ? AND seen = 0`

The manifest grows across attempts. A dag-pb node received on attempt 2 may reveal new leaf CIDs not visible on attempt 1.

## Backend Interface

```typescript
interface ExportBackend {
  name: string

  // Lifecycle
  init?(): Promise<void>
  close?(): Promise<void>

  // Happy path: import a CAR byte stream or block stream
  importCar(
    rootCid: string,
    stream: BlockStream | AsyncIterable<Uint8Array> | NodeJS.ReadableStream
  ): Promise<void>

  // Cheap existence/pinning check
  hasContent?(rootCid: string): Promise<boolean>

  // Block-level operations (optional, for repair)
  hasBlock?(cid: string): Promise<boolean>
  putBlock?(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void>

  // Deep verification (authoritative completion check)
  verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }>
}
```

### Kubo backend
- `importCar`: streams CAR bytes via multipart to `dag/import`
- `hasBlock`: `POST /api/v0/block/stat?arg=<cid>`
- `putBlock`: `POST /api/v0/block/put` with multipart
- `hasContent`: optional pin/existence hint via `POST /api/v0/pin/ls?arg=<cid>&type=recursive`
- `verifyDag`: `POST /api/v0/dag/stat?arg=<cid>` — verifies full DAG traversal

### Local backend
- `importCar`: writes CAR bytes to disk
- `hasContent`: optional file-exists hint
- `putBlock`: appends fetched blocks to a repair sidecar CAR keyed by `rootCid`
- `verifyDag`: parse the CAR file with `@ipld/car`, walk the root-reachable DAG, and require every reachable block to be present

## Phases and Dashboard

The tool runs in three phases, reflected in the dashboard:

### Phase 1: Discovery
- Detect credentials
- Enumerate spaces and uploads
- Collect space sizes (cached in DB after first run)

Dashboard shows: spaces found, upload counts per space.

### Phase 2: Export
- For each pending upload, call `verifyDag(rootCid)` first. If it passes, mark the upload complete without downloading.
- Download CARs with inline repair
- Use one shared gateway fetch coordinator for the whole export run so 429 backoff is global across concurrent workers
- Each upload's lifecycle is visible individually:
  ```
  Smithsonian/bafybeic3yr... → Downloading (1400/? blocks, 1.2 GiB)
  Smithsonian/bafybeic3yr... → Partial (1475 seen, 346 missing) → Repairing (200/346)
  Smithsonian/bafybeic3yr... → Complete ✓ (1821 blocks, 1.8 GiB)
  ```
- Per-space progress bars by upload count (not bytes — Storacha size reporting doesn't match CAR sizes)
- Active downloads with block count and byte count, updated live
- Spaces sorted: in-progress at top, complete below, pending at bottom

### Phase 3: Verify
- Confirm every `complete` upload is actually present in each backend
- Per-upload verification status: checking / verified / failed
- Failed uploads moved back to `partial` for re-repair
- Summary: "N verified, M failed → moved to partial"

All phases show the live log panel at the bottom with color-coded structured logging (timestamps, PIDs, levels).

### Dashboard Server
- `--serve [host:port]` — built-in HTTP server (default: `127.0.0.1:9000`)
- `--serve-password <pass>` — HTTP Basic Auth
- `--html-out <path>` — write static HTML snapshot every 2s for external web servers
- Auto-refresh via meta tag
- PID displayed (not "Running/Stopped" — the server IS the process)

## CLI Interface

```bash
# Interactive wizard (no args)
storacha-export

# Full CLI
storacha-export --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Select/exclude spaces
storacha-export --space Smithsonian --space DPLA --backend kubo ...
storacha-export --exclude-space BlueSky_Backups --backend kubo ...

# Concurrency
storacha-export --concurrency 3 --backend kubo ...

# Start fresh (discard progress tracking, not exported data)
storacha-export --fresh --backend kubo ...

# Verify only (skip export, just check)
storacha-export --verify --backend kubo ...

# Dashboard
storacha-export --serve 0.0.0.0:8087 --html-out /var/www/export.html ...
```

Auto-resume is the default when a DB exists. No `--continue` flag.

## Concurrency and Politeness

- Default: 3 concurrent transfers
- `--concurrency N` for parallel downloads
- One shared `GatewayFetcher` coordinates all concurrent workers in an export run
- Exponential backoff on 429/5xx, respects `Retry-After`
- CAR fetch timeout: 60s for headers, 2 minutes between chunks; block fetch timeout: 30s
- Cancel response bodies on error to prevent socket pool exhaustion

## Streaming Rules

1. Never buffer an entire CAR or block set in memory
2. Parse CAR blocks inline as they stream through
3. For repair: push blocks to backend individually (`putBlock`) as they're fetched — don't accumulate
4. For local backend repair: stream blocks to a new CAR file as they arrive
5. The only in-memory accumulation is the block manifest metadata (CID strings + codecs), not block data

## Project Structure

```
storacha-export/
├── src/
│   ├── index.ts          # entry point
│   ├── cli.ts            # argument parsing, wizard (thin)
│   ├── phases/
│   │   ├── discover.ts   # auth, space enumeration
│   │   ├── export.ts     # download orchestration with inline repair
│   │   └── verify.ts     # final verification pass
│   ├── core/
│   │   ├── blocks.ts     # BlockStream type, CAR parser adapter
│   │   ├── manifest.ts   # SQLite block manifest operations
│   │   ├── queue.ts      # SQLite upload queue operations
│   │   ├── fetcher.ts    # gateway CAR fetcher + individual block fetcher
│   │   └── repair.ts     # repair logic using manifest
│   ├── backends/
│   │   ├── interface.ts  # ExportBackend type definition
│   │   ├── kubo.ts
│   │   └── local.ts
│   ├── dashboard/
│   │   ├── server.ts     # HTTP server with auth
│   │   └── html.ts       # HTML generator
│   └── util/
│       ├── log.ts        # structured logging with timestamps/PIDs
│       └── progress.ts   # TTY/non-TTY display
├── test/
├── docs/
├── package.json
└── tsconfig.json
```

## Dependencies

- `@storacha/client` — auth, space listing, upload enumeration
- `@ipld/car` — CAR parsing (streaming block iterator)
- `@ipld/dag-pb` — dag-pb decoding for link extraction
- `multiformats` — CID handling, sha256 verification
- `better-sqlite3` — job queue and block manifest
- `undici` — HTTP client with configurable timeouts
- `commander` — CLI argument parsing
- `@inquirer/prompts` — interactive wizard
- `ora` — TTY spinners
- `cli-progress` — TTY progress bars
- `typescript` — type safety

## What We Keep From v1

- SQLite as the state store (proven reliable)
- Auth detection flow (check own profile, then CLI profile)
- Space enumeration via `@storacha/client`
- Kubo multipart streaming (async generator approach)
- Auto-resume by default, `--fresh` to start over
- Structured logging with timestamps and PIDs
- Rooster farewell message

## What We Fix From v1

| v1 Problem | v2 Solution |
|-----------|-------------|
| Node/Web streams mismatch (4 bugs) | `BlockStream` abstraction, adapters at edges only |
| Repair bolted on, buffers in memory | First-class manifest tracking, stream blocks individually |
| Can't resume mid-CAR | Block manifest tracks progress within each upload |
| `cli.js` at 487 lines doing everything | Split into phases/, core/, dashboard/ |
| Byte counts unreliable for progress | Show block counts, treat byte totals as informational |
| No verification | Dedicated verify phase with per-backend deep checks |
| `parseInt` radix bug, `bytes`/`byteCount` typo | TypeScript catches these at compile time |
| Dashboard external script polling DB | Integrated server with direct access to state |

## Risks

- `@ipld/car` streaming parser may have edge cases with malformed CARs — test with real truncated CARs from v1
- Block-level manifest for very large uploads (millions of blocks) could slow SQLite — index on `(root_cid, seen)` and test at scale
- Storacha's `@storacha/client` TypeScript types may not align with runtime behavior — trust runtime, not types
- Gateway may change behavior before migration completes — keep v1 working as fallback

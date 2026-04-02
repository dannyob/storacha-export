# storacha-export

Export your Storacha / web3.storage space content to local files or IPFS (Kubo).

## How it works

storacha-export runs in three phases:

1. **Discover** -- detect credentials, enumerate spaces and uploads, cache space metadata in SQLite.
2. **Export** -- ask the target backend whether the DAG is already complete, otherwise download CARs from the Storacha gateway with inline repair for truncated downloads.
3. **Verify** -- confirm every exported upload is actually present and complete in each backend.

### Inline repair

The Storacha gateway sometimes truncates large CAR downloads mid-stream. Rather than treating this as a failure, storacha-export treats it as progress:

- A **block manifest** in SQLite tracks every block seen and every link discovered from dag-pb nodes.
- When a download is truncated, the manifest knows exactly which blocks are missing.
- Missing intermediate (dag-pb) nodes are fetched as **sub-CARs**, pulling their entire subtrees in one request.
- Remaining missing blocks are fetched individually from the gateway (`?format=raw`).
- Progress accumulates across runs. An upload truncated at 50% has made 50% progress -- the next run picks up from there.

Each upload moves through: `pending -> downloading -> partial -> repairing -> complete` (or `error` after the retry limit).

## Backends

### `local` -- CAR files on disk

Writes each upload as a CAR file in an output directory. On repair, reads the existing truncated CAR from disk, fetches missing blocks, and writes a complete replacement. Completeness means the root CID is present and every reachable block in the DAG is present in the CAR.

### `kubo` -- IPFS node

Streams raw CAR bytes directly to kubo's `dag/import` endpoint. Repair pushes individual blocks via `block/put`. Completeness is checked with `dag/stat`, not just root pin existence.

## Dashboard

- `--serve [host:port]` starts a built-in HTTP server (default `127.0.0.1:9000`) showing live export progress -- per-space stats, active downloads with transfer rates and ETAs, block-level repair progress, and a log panel. Updates in-place without page reloads.
- `--serve-password <pass>` enables HTTP Basic Auth.
- `--html-out <path>` writes a static HTML snapshot every 2 seconds for use with an external web server.

## Install

```bash
npm install -g storacha-export
```

Or run directly:

```bash
npx storacha-export
```

## Usage

Run without arguments for the interactive wizard:

```bash
storacha-export
```

CLI examples:

```bash
# Export to local CAR files
storacha-export --backend local --output ./my-cars/

# Export to a Kubo node
storacha-export --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export specific spaces only
storacha-export --space "MySpace" --space "OtherSpace" --backend local --output ./cars/

# Exclude certain spaces
storacha-export --exclude-space "BigSpace" --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Parallel downloads with dashboard
storacha-export --concurrency 4 --serve 0.0.0.0:8087 --backend kubo

# Verify only (skip export, just check backends)
storacha-export --verify --backend kubo

# Start fresh (discard progress tracking, not exported data)
storacha-export --fresh --backend local --output ./cars/

# Dashboard + static HTML snapshot
storacha-export --serve 0.0.0.0:8087 --html-out /var/www/export.html --backend kubo
```

## Options

| Option | Description |
|--------|-------------|
| `--backend <type...>` | Backend(s): `local` or `kubo` |
| `--output <dir>` | Output directory (local backend) |
| `--kubo-api <url>` | Kubo API endpoint (URL or multiaddr, default: `http://127.0.0.1:5001`) |
| `--space <name...>` | Export only named spaces (repeatable) |
| `--exclude-space <name...>` | Skip named spaces (repeatable) |
| `--gateway <url>` | Gateway URL (default: `https://w3s.link`) |
| `--concurrency <n>` | Parallel transfers (default: 3) |
| `--fresh` | Discard previous progress tracking and start over |
| `--verify` | Run verification phase only |
| `--serve [host:port]` | Start dashboard HTTP server (default: `127.0.0.1:9000`) |
| `--serve-password <pass>` | HTTP Basic Auth for dashboard |
| `--html-out <path>` | Write static HTML dashboard snapshot |
| `--db <path>` | SQLite DB path (default: `storacha-export.db`) |

## Resume

Export progress is tracked in a SQLite database (`storacha-export.db`). If an export is interrupted, re-run the same command -- it picks up where it left off automatically, including mid-upload progress at the block level. Existing backend data is re-checked with backend verification before any upload is treated as complete.

Use `--fresh` to start over. This resets the progress tracking only; data already exported to backends is not affected.

## License

AGPL-3.0-or-later

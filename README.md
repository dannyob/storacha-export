# storacha-export

Export your Storacha / web3.storage space content to local files, IPFS (Kubo), or IPFS Cluster.

## How it works

storacha-export runs in three phases:

1. **Discover** -- detect credentials, enumerate spaces and uploads, cache space metadata in SQLite.
2. **Export** -- download CARs from the Storacha gateway, with inline repair for truncated downloads.
3. **Verify** -- confirm every exported upload is actually present and complete in each backend.

### BlockStream architecture

All data flows through a single abstraction:

```typescript
type Block = { cid: CID; bytes: Uint8Array }
type BlockStream = AsyncIterable<Block>
```

The gateway CAR fetcher produces a BlockStream. The manifest tracker transforms it, recording every block CID in SQLite as blocks stream through. Backends consume it. Node streams and Web streams only appear at adapter boundaries -- the core logic never touches them, and nothing is buffered in memory.

### Inline repair

The Storacha gateway sometimes truncates large CAR downloads mid-stream. Rather than treating this as a failure, storacha-export treats it as progress:

- A **block manifest** in SQLite tracks every block seen and every link discovered from dag-pb structure nodes.
- When a download is truncated, the manifest knows exactly which blocks are missing.
- Missing blocks are fetched individually from the gateway (`?format=raw`) and streamed to the backend one at a time.
- Progress accumulates across attempts. A 3.7 TiB upload truncated at 2 TiB has made 2 TiB of progress -- the next attempt picks up from there.

Each upload moves through: `pending -> downloading -> partial -> repairing -> complete` (or `error` after the retry limit).

## Backends

### `local` -- CAR files on disk

Writes blocks to CAR files in an output directory. On repair, reads the existing truncated CAR (no re-download), identifies missing blocks, fetches them, and writes a complete replacement.

### `kubo` -- IPFS node

Wraps the BlockStream back into a CAR and streams it to `dag/import` via multipart. Repair pushes individual blocks via `block/put`. Verification uses `dag/stat` for full DAG traversal.

### `cluster` -- IPFS Cluster

Same as kubo but via the Cluster REST API.

## Dashboard

- `--serve [host:port]` starts a built-in HTTP server (default `127.0.0.1`, random port) showing live export progress -- spaces, uploads, block counts, and a log panel.
- `--serve-password <pass>` enables HTTP Basic Auth.
- `--html-out <path>` writes a static HTML snapshot every 5 seconds for use with an external web server. Auto-refreshes via meta tag.

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

# Parallel downloads
storacha-export --concurrency 3 --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Verify only (skip export, just check backends)
storacha-export --verify --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Start fresh (discard progress tracking, not exported data)
storacha-export --fresh --backend local --output ./cars/

# Dashboard server
storacha-export --serve 0.0.0.0:8087 --html-out /var/www/export.html --backend kubo ...
```

## Options

| Option | Description |
|--------|-------------|
| `--backend <type>` | Backend: `local`, `kubo`, or `cluster` |
| `--output <dir>` | Output directory (local backend) |
| `--kubo-api <url>` | Kubo API endpoint (URL or multiaddr) |
| `--cluster-api <url>` | IPFS Cluster API endpoint |
| `--space <name...>` | Export only named spaces (repeatable) |
| `--exclude-space <name...>` | Skip named spaces (repeatable) |
| `--gateway <url>` | Gateway URL (default: `https://w3s.link`) |
| `--concurrency <n>` | Parallel transfers (default: 1) |
| `--fresh` | Discard previous progress tracking and start over |
| `--verify` | Run verification phase only |
| `--serve [host:port]` | Start dashboard HTTP server |
| `--serve-password <pass>` | HTTP Basic Auth for dashboard |
| `--html-out <path>` | Write static HTML dashboard snapshot |
| `--db <path>` | SQLite DB path (default: `storacha-export.db`) |
| `--dry-run` | Enumerate uploads without exporting |

## Resume

Export progress is tracked in a SQLite database (`storacha-export.db`). If an export is interrupted, re-run the same command -- it picks up where it left off automatically, including mid-upload progress at the block level.

Use `--fresh` to start over. This resets the progress tracking only; data already exported to backends is not affected.

## License

AGPL-3.0-or-later

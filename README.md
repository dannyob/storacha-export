# storacha-export

Export your Storacha space content to local files, IPFS (Kubo), or IPFS Cluster.

## Install

```bash
npm install -g storacha-export
```

Or run directly:

```bash
npx storacha-export
```

## Quick Start

Run without arguments for the interactive wizard:

```bash
storacha-export
```

The wizard will:
1. Detect your existing Storacha credentials (or help you log in)
2. Let you select which spaces to export
3. Let you choose where to export (local files, Kubo, IPFS Cluster)
4. Start the export with progress tracking

## CLI Usage

```bash
# Export to local CAR files
storacha-export --backend local --output ./my-cars/

# Export to a Kubo node
storacha-export --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export to multiple backends at once
storacha-export --backend local --output ./cars/ --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export specific spaces only
storacha-export --space "MySpace" --space "OtherSpace" --backend local --output ./cars/

# Export all except certain spaces
storacha-export --exclude-space "BigSpace" --backend local --output ./cars/

# Resume an interrupted export (automatic — just re-run)
storacha-export --backend local --output ./cars/

# Dry run — see what would be exported
storacha-export --dry-run --backend local --output ./cars/
```

## Options

| Option | Description |
|--------|-------------|
| `--backend <type...>` | Backend(s): `local`, `kubo`, `cluster` |
| `--output <dir>` | Output directory (local backend) |
| `--kubo-api <url>` | Kubo API endpoint (URL or multiaddr) |
| `--cluster-api <url>` | IPFS Cluster API endpoint |
| `--space <name...>` | Export only named spaces (repeatable) |
| `--exclude-space <name...>` | Skip named spaces (repeatable) |
| `--fresh` | Start over, discarding previous progress tracking |
| `--concurrency <n>` | Parallel transfers (default: 1) |
| `--dry-run` | Enumerate only |
| `--gateway <url>` | Gateway URL (default: https://w3s.link) |
| `--db <path>` | SQLite DB path (default: storacha-export.db) |

## Resumability

Export progress is tracked in a SQLite database (`storacha-export.db`). If an export is interrupted, just re-run — it automatically picks up where it left off, skipping already-exported content.

Even if the database is lost, the tool checks each backend to see what content is already present before re-downloading.

Use `--fresh` to start over (this only resets the progress tracking — already-exported data in your backends is not affected).

## Truncated CAR Repair

The Storacha gateway sometimes serves incomplete CAR files for large uploads — the download cuts off mid-stream, producing a truncated file that `dag import` rejects with "unexpected EOF".

When this happens, `storacha-export` automatically attempts repair:

1. Re-downloads the (truncated) CAR and parses what it can
2. From the DAG-PB structure nodes, identifies all links to missing leaf blocks
3. Fetches each missing block individually from the gateway (`?format=raw`)
4. Builds a small CAR containing just the missing blocks and imports it

This works because the gateway reliably serves individual blocks even when it can't serve the complete CAR in one stream. The DAG structure nodes (which describe the file layout) appear early in the CAR, so they're almost always present in the truncated download — only the raw data leaves at the tail are missing.

If the DAG structure itself is incomplete (missing intermediate nodes, not just leaves), repair is not possible and the error is reported normally.

## License

AGPL-3.0-or-later

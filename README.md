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

# Resume an interrupted export
storacha-export --continue --backend local --output ./cars/

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
| `--continue` | Resume previous export |
| `--concurrency <n>` | Parallel transfers (default: 1) |
| `--dry-run` | Enumerate only |
| `--gateway <url>` | Gateway URL (default: https://w3s.link) |
| `--db <path>` | SQLite DB path (default: storacha-export.db) |

## Resumability

Export progress is tracked in a SQLite database (`storacha-export.db`). If an export is interrupted, re-run with `--continue` to pick up where you left off.

Even if the database is lost, `--continue` will check each backend to see what content is already present before re-downloading.

## License

AGPL-3.0-or-later

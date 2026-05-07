# storacha-download

Two small standalone TypeScript scripts for working with Storacha / web3.storage data:

- **`storacha-download.mts`** — download every upload in your Storacha spaces as CAR shards.
- **`car-to-tar.mts`** — convert one or more CAR files into a TAR archive of the original UnixFS files.

Both scripts run directly via `tsx`. There is no compiled build step.

## Install

```bash
git clone git@github.com:dannyob/storacha-export.git
cd storacha-export
npm install
```

Node ≥ 20 required. There is no build step — both scripts run directly via `tsx`.

## Authenticate

Log in once with your email. Storacha emails you a confirmation link; click it and the script saves your credentials.

```bash
npx tsx storacha-download.mts --login your@email.com
# (check your inbox; click the link; the script will exit when login is confirmed)
```

Credentials are stored in a [`@storacha/client`](https://www.npmjs.com/package/@storacha/client) `StoreConf` profile named `storacha-export`. On macOS the data lives in `~/Library/Preferences/storacha-export-nodejs/config.json`; on Linux, `~/.config/storacha-export-nodejs/config.json`. After the first login you don't need `--login` again.

If you've already authenticated using the official Storacha CLI (`@storacha/cli`'s `storacha login`), `storacha-download` will pick up that profile too — no separate login needed.

## storacha-download

Auths against your Storacha credentials, enumerates spaces and uploads, resolves shard locations from the Storacha indexing service, and downloads each shard from R2 as `<root-cid>.shard-N.car`.

State (spaces, uploads, shards, downloaded files) is persisted to a SQLite DB so re-running picks up where it left off.

```bash
# Download every space's uploads to ./cars
npx tsx storacha-download.mts --output ./cars

# Just one space, with 5 concurrent shard fetches
npx tsx storacha-download.mts --space DataCivica --output /store/cars --concurrency 5

# List spaces and per-space sizes; no downloads, no DB writes
npx tsx storacha-download.mts --list-spaces
```

| Flag | Default | Description |
|---|---|---|
| `--output PATH` | `./cars` | Directory for shard CAR files |
| `--space NAME` | (all) | Limit to a single space (case-insensitive) |
| `--concurrency N` | `3` | Parallel shard downloads |
| `--db PATH` | `./storacha-download.db` | SQLite progress DB |
| `--list-spaces` | — | Print spaces (with sizes) and exit |
| `--login EMAIL` | — | Log in via email link, save credentials, exit |

### SQLite schema

The DB is the contract between this script and any external consumer. It has four tables: `spaces`, `uploads`, `shards`, `files`. See the `db.exec(...)` block at the top of `storacha-download.mts` for the column definitions.

## car-to-tar

Reads UnixFS DAGs from CAR files and emits a TAR archive of the original file tree. No network — works on any CAR.

```bash
# Convert one CAR; output goes to ./<root-cid>.tar
npx tsx car-to-tar.mts foo.car

# Pool every shard of a sharded upload
npx tsx car-to-tar.mts <root>.shard-*.car

# Pipe to tar
npx tsx car-to-tar.mts foo.car --stdout | tar tvf -
```

| Flag | Description |
|---|---|
| `-o, --out PATH` | Output path (default `./<root-cid>.tar`) |
| `--stdout` | Write tar to stdout; logs go to stderr |
| `--root CID` | Override root CID (when CAR headers are missing/disagree) |

Files whose blocks can't be found are skipped with a `WARN` on stderr; the resulting tar is always valid. Exit codes: `0` on any extraction, `1` on setup failure (no CARs, root unresolvable), `2` if zero entries were extracted.

## Tests

```bash
npm test
```

Tests cover `car-to-tar` end-to-end against in-memory CARs (build with `ipfs-unixfs-importer`, convert, parse the tar back). `storacha-download.mts` is not unit-tested — auth and the indexing service make it integration territory; behavior is verified in production.

## License

AGPL-3.0-or-later

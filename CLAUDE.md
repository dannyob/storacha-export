# CLAUDE.md

Notes for Claude Code working in this repo.

## What this is

Two flat standalone TypeScript scripts:

- `storacha-export.mts` — download Storacha space content as CAR shards
- `car-to-tar.mts` — convert CAR file(s) to a TAR archive of the original UnixFS files

`auth.mts` is a small shared module used only by `storacha-export.mts`.

There is no `src/` directory. There is no compiled output. Scripts run via `tsx` directly. The `bin` entries in `package.json` point at the `.mts` files.

## Commands

```bash
npm install      # install deps
npm test         # vitest run
npx tsx storacha-export.mts --list-spaces   # quick auth/connectivity check
npx tsx car-to-tar.mts <car-file>...          # CAR → TAR
```

## storacha-export.mts

Renamed from `storacha-download.mts` on 2026-05-08 (matches the repo / package name). Three phases, all in one file:

1. Auth via `auth.mts`. Reads an existing `storacha-export` or `storacha-cli` credential profile from `~/Library/Preferences/storacha-*` (macOS) / `~/.config/storacha-*` (Linux). `--login <email>` triggers an inline login flow that writes to the `storacha-export` profile.
2. Enumerate uploads per space, cached in SQLite (`spaces`, `uploads` tables).
3. Resolve shard locations via the indexing-service client (`shards` table), then download each shard's CAR from R2 (`files` table).

The SQLite DB is the resume contract: re-running picks up where it left off. Schema is defined in the `db.exec(...)` block at the top of the script.

`--list-spaces` prints names + DIDs + (best-effort) sizes via the usage report API and exits **before** any DB file is created.

## car-to-tar.mts

Pure bytes-in/bytes-out. No network. Uses `@ipld/car` to read CARs into an in-memory `Map<cidStr, bytes>` blockstore, `ipfs-unixfs-exporter` to walk the DAG (note: `recursive()` and `entries()` yield stripped stubs — call `exporter(stub.cid, blockstore)` to get a full entry with `content()` / `entries()`), and `tar-stream` to write the archive.

The exported `convert()` function takes a `Writable` for output, which is what tests use. The CLI at the bottom of the file wraps `convert()` with arg parsing, output-path resolution, and a stderr summary.

Best-effort: missing blocks → file skipped with a `WARN` to stderr, tar stays valid. Skipping is intentional — `tar-stream` requires the entry size up front, so we cannot emit a truncated entry without producing a malformed archive.

## Conventions

- ES modules (`"type": "module"`).
- `.mts` for the runnable scripts; tests are `.ts` (vitest globals enabled).
- Node >= 20.
- `vitest.config.ts` includes a `prefer-ts` plugin from the old `src/` layout. It is harmless but unused now; keep it or delete in a future cleanup.
- Test temp files use `os.tmpdir()` and clean up in `afterEach`.

## Pre-existing notes

- The fatfil deployment runs an older checkout of this code (the previous pluggable-backend / kubo / dashboard architecture). It is unaffected by this branch. Do not assume this script is the one running in production unless you have explicitly redeployed.

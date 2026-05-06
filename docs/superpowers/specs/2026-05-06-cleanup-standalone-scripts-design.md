# Cleanup to standalone scripts (with CAR→TAR converter)

**Date:** 2026-05-06
**Branch:** `cleanup/standalone-scripts`
**Worktree:** `.worktrees/cleanup-standalone`

## Goal

Reduce this repository to two simple standalone TypeScript scripts:

1. `storacha-download.mts` — download Storacha space content as CAR shards (existing, cleaned up).
2. `car-to-tar.mts` — convert one or more CAR files to a TAR archive of the original UnixFS files (new).

Delete every other historical approach: pluggable backends, kubo integration, gateway-based export with inline repair, the dashboard, the three-phase export pipeline, all of `src/`.

The end state is a flat repo of `.mts` scripts runnable directly via `tsx`, with no compiled build step.

## Background

The repo previously housed a pluggable export pipeline (kubo backend, local CAR backend, gateway-based fetching with block-level repair, SQLite block manifest, three-phase discover/export/verify) that proved too slow on large spaces. The current production approach — used to export ~36k uploads from many spaces to fatfil's kubo — is the shard-based path that fetches CARs directly from R2 using location claims from the Storacha indexing service. That path was extracted into a single ~300-line script: `storacha-download.mts`. Everything else is dead code.

This cleanup keeps only what's load-bearing for the shard-based download path, and adds a complementary tool to extract original files from downloaded CARs.

## Repo shape after cleanup

Flat layout, no `src/` directory:

```
.
├── storacha-download.mts   # cleaned up; gains --list-spaces flag
├── car-to-tar.mts          # NEW
├── auth.mts                # extracted verbatim from src/auth.ts
├── test/
│   └── car-to-tar.test.ts  # NEW
├── package.json            # renamed, deps stripped
├── tsconfig.json
├── README.md               # rewritten
├── CLAUDE.md               # rewritten
└── .gitignore
```

### Deleted

- `src/` (entire tree: `auth`, `backends`, `core`, `dashboard`, `phases`, `util`, `cli.ts`, `index.ts`)
- `test/` (entire tree — tests for `src/`; replaced by a single new test file)
- `storacha-dashboard.mts`
- `shard-import.mts`
- `list-spaces.mts` (folded into `storacha-download.mts --list-spaces`)
- `test-resolve-full.mts`, `test-shard-timing.mts` (debug scripts)
- `bin/`, `dist/` (no compiled output; scripts run via `tsx`)
- Most of `docs/` — old plans no longer reflect reality. Keep this design doc and the new README.

The fatfil deployment tracks the old code; it remains untouched. This branch produces a clean future state for new work.

## `storacha-download.mts` — changes

The script's three-phase shape is unchanged: auth → enumerate spaces (cached in SQLite) → resolve shards via the indexing service → download CARs as `<root>.shard-N.car`. Existing `storacha-download.db` files are forward-compatible without migration; the schema (`spaces`, `uploads`, `shards`, `files`) is preserved.

Two changes:

1. **`--list-spaces` mode.** When passed, the script auths, prints `<name> — <did> — <size>` for every space (using the usage-report logic currently in `list-spaces.mts`), and exits without DB writes, shard resolution, or downloads. Replaces the standalone `list-spaces.mts`.
2. **Auth import path.** `from './src/auth.js'` → `from './auth.mts'`. `auth.mts` is a verbatim move of `src/auth.ts`, no logic changes.

All current flags (`--space`, `--concurrency`, `--output`, `--db`) and behavior preserved.

## `car-to-tar.mts` — new

Pure bytes-in/bytes-out utility. No network, no auth, no Storacha-specific knowledge — works on any CAR file.

### CLI

```
car-to-tar [options] <car-file>...

Options:
  -o, --out PATH     Output path (default: ./<root-cid>.tar)
  --stdout           Write tar to stdout (binary); logs still go to stderr
  --root CID         Override root CID (escape hatch for ambiguous/missing headers)
  -h, --help
```

Defaults to writing to a file. `--stdout` enables piping (`car-to-tar foo.car --stdout | tar tvf -`). Logs and progress always go to stderr.

### Pipeline

1. **Open each CAR.** `CarReader.fromIterable(fs.createReadStream(path))` from `@ipld/car`. Read header → collect declared roots. Stream blocks into an in-memory `Map<cidStr, Uint8Array>` blockstore (pooled across all input CARs — this is how shards get joined).
2. **Resolve root CID.** Either `--root`, or take the unique root from the union of headers. Error if there's disagreement and no `--root`.
3. **Walk the DAG.** Use `ipfs-unixfs-exporter`: `exporter(rootCid, blockstore)` returns an async iterable of `UnixFSEntry` with `path`, `type`, `size`, `content()`.
4. **Emit TAR.** `tar-stream` `pack()`. For each entry:
   - `directory` → `pack.entry({ name: path + '/', type: 'directory' })`
   - `file` / `raw` → `pack.entry({ name, size, type: 'file' })`, pipe `content()` into it
   - `symlink` → type `'symlink'` with linkname from UnixFS data
   Pipe pack stream to either `fs.createWriteStream(outPath)` or `process.stdout`.

### Edge cases

- **Root is a single file (not a directory):** UnixFS doesn't store a name on the root. Emit as a single TAR entry named `<root-cid>`.
- **Multiple roots in headers / disagreement:** error unless `--root` overrides.
- **Empty input file list:** error.

### Memory model

In-memory blockstore. Typical Storacha uploads (sub-GB DAG even when split across shards) fit comfortably on a 20GB-RAM host running one extraction at a time. If a future need to extract multi-tens-of-GB single uploads arises, add a disk-backed CAR-indexed blockstore — but YAGNI: not building it now.

### Error handling — best-effort extraction

The tool tries to extract as much as possible and emits warnings for everything else.

- **File entry, content fully readable** → include in tar.
- **File entry, any block missing mid-stream** → skip (don't write a malformed entry with wrong size). Log `WARN: truncated <path> (<cid>): missing block <cid>` to stderr.
- **Directory enumeration fails partway** (HAMT shard missing, link target missing) → keep entries collected before the failure. Log `WARN: partial directory <path> (<cid>): <reason>`. Continue with whatever sibling we can reach.
- **Root block itself missing** → fail; nothing to extract.

End-of-run summary on stderr:
```
Extracted: 1,234 entries (5.2 GiB)
Skipped:   3 files (missing blocks)
Warnings:  4
```

Exit codes:
- `0` — at least one entry extracted (regardless of warnings)
- `1` — crashed before extraction could begin (CAR parse error, root block missing, no input files)
- `2` — extraction ran but yielded zero entries

The output tar at `<out>` is the partial archive on partial success — kept as-is. The stderr summary is the authoritative status.

### Why skip rather than pad truncated files

`tar-stream` requires the entry size up front. Closing an entry with fewer bytes than the declared size produces a malformed tar archive. Skipping keeps the archive valid and makes the missing-content situation explicit via the warnings.

## Tests

`test/car-to-tar.test.ts` — pure-logic unit tests, no network. Refactor the script's core into an exported `convert()` function; CLI is a thin wrapper around it. Build small CARs in memory using `@ipld/car`'s writer + `ipfs-unixfs-importer`.

Cases:

1. Single small file → tar has one entry, content matches.
2. Directory with two files → tar has dir + two file entries with correct paths.
3. Multiple shard CARs forming one DAG → joined correctly across inputs.
4. Missing block → file is skipped, warning logged, exit 0, tar still parseable (verify by piping output through `tar-stream`'s extract).
5. CAR header roots disagree, no `--root` → error.
6. `--root` overrides ambiguous header.

`storacha-download.mts` is not unit-tested. It's hard to test (auth, network, Storacha indexing service) and battle-tested in production via the 36k-uploads run on fatfil.

## `package.json`

```json
{
  "name": "storacha-download",
  "version": "0.1.0",
  "description": "Download Storacha space content as CAR shards; convert CAR to TAR.",
  "type": "module",
  "bin": {
    "storacha-download": "./storacha-download.mts",
    "car-to-tar": "./car-to-tar.mts"
  },
  "scripts": {
    "test": "vitest run"
  },
  "license": "AGPL-3.0-or-later",
  "engines": { "node": ">=20" }
}
```

### Dependency delta

| Drop | Keep | Add |
|---|---|---|
| `@inquirer/prompts` | `@ipld/car` | `ipfs-unixfs-exporter` |
| `@ipld/dag-pb` | `@storacha/client` | `ipfs-unixfs-importer` (dev — for tests) |
| `cli-progress` | `@storacha/indexing-service-client` | `tar-stream` |
| `commander` | `better-sqlite3` | `interface-blockstore` |
| `ora` | `multiformats` | `@types/tar-stream` (dev) |
| `pino` | `undici` | |

devDeps unchanged otherwise (`vitest`, `tsx`, `typescript`, `@types/node`, `@types/better-sqlite3`).

## Docs

- **`README.md`** — short rewrite covering: what each script does, install (`npm install`), usage examples, the SQLite schema (it's the contract between `storacha-download` and any external consumer of the DB).
- **`CLAUDE.md`** — short rewrite to match the flat-script reality. The current file describes the deleted phases/backends/repair architecture; almost none of it is true after this branch.

## Worktree

Worktree already created at `.worktrees/cleanup-standalone` on branch `cleanup/standalone-scripts`. `npm install` ran successfully. Pre-existing test failures (39/82) are entirely in `test/phases/`, `test/core/` for code being deleted in this branch — not relevant to this work.

## Out of scope

- Extracting truncated files via buffer-then-emit-actual-size (file-by-file). Could add later if the all-or-nothing skip turns out to be too coarse.
- Disk-backed CAR-indexed blockstore for very large single uploads. Add when first needed.
- Migrating the running fatfil deployment. fatfil keeps tracking the old checkout. This branch is a future state for new work, not a hot-swap.
- Refactoring or testing `storacha-dashboard.mts`. The dashboard is being deleted in this branch; the running instance on fatfil is unaffected.

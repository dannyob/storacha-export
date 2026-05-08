# storacha-export

**Rescue your data out of Storacha (web3.storage) before shutdown.** Downloads every upload from your Storacha spaces and reconstructs the original directory tree on your disk.

## Quick start

```bash
# 1. install Node 20+ (skip if you already have it)
#    macOS:    brew install node
#    Linux/WSL: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
#               . ~/.nvm/nvm.sh && nvm install 20
#    Windows:  https://nodejs.org/

# 2. clone this repo and install dependencies
git clone https://github.com/dannyob/storacha-export.git
cd storacha-export
npm install

# 3. log in (use the email you registered with Storacha; click the link in your inbox)
npx tsx storacha-export.mts --login your@email.com

# 4. see what's in your account
npx tsx storacha-export.mts --list-spaces

# 5. download and extract everything from a space — files end up under ./files/<space>/
npx tsx storacha-export.mts --space "MySpaceName" --extract
```

That's it. Your reconstructed files land under `./files/<space>/<upload-id>/`. Raw CAR files (the on-disk format Storacha uses) stay in `./cars/` as a backup.

## What is this?

Two small standalone scripts:

- **`storacha-export.mts`** — talks to Storacha, finds your data, downloads it to `./cars/`. With `--extract`, it also reconstructs the original files into `./files/`.
- **`car-to-tar.mts`** — pure file-format converter: takes raw CAR files and emits a TAR archive of the directory tree they contain. No network. Useful if you have CAR files from any source, not just Storacha.

The scripts run directly via `tsx`; there's no build step. State is kept in `./storacha-export.db` (SQLite) so a re-run resumes where it left off — interrupt with Ctrl-C any time.

## Common flows

```bash
# Just one space, just download (don't extract — leave you the raw CARs)
npx tsx storacha-export.mts --space "MyArchive"

# All spaces, with extraction (can take a long time and a lot of disk)
npx tsx storacha-export.mts --all --extract

# Resume an interrupted run — same command picks up where it left off
npx tsx storacha-export.mts --space "MyArchive" --extract

# More parallel HTTP fetches if your network is fast
npx tsx storacha-export.mts --space "MyArchive" --extract --concurrency 6

# Convert raw CARs to a TAR archive (separately, no network)
npx tsx car-to-tar.mts cars/<upload-id>.shard-*.car -o myupload.tar
tar xf myupload.tar
```

## Authentication

`--login your@email.com` sends a confirmation link; once you click it the script saves credentials so subsequent runs need no flag.

Credentials are stored on disk:
- macOS: `~/Library/Preferences/w3access/storacha-export.json`
- Linux: `~/.config/w3access/storacha-export.json`

If you already use the official Storacha CLI (`@storacha/cli`'s `storacha login`), this script picks up that profile too — no separate login needed.

## All options

`storacha-export.mts`:

| Flag | Default | Description |
|---|---|---|
| `--space NAME` | — | Download just one space, by name (case-insensitive) |
| `--all` | — | Download every space. Either `--space` or `--all` is required |
| `--extract` | off | After download, reconstruct files into `./files/<space>/...` |
| `--output PATH` | `./cars` | Where to put raw CAR files |
| `--concurrency N` | `3` | Parallel HTTP fetches |
| `--db PATH` | `./storacha-export.db` | SQLite progress DB (the resume contract) |
| `--list-spaces` | — | Print spaces and exit, no downloads |
| `--login EMAIL` | — | Log in via email link, save credentials, exit |
| `-h, --help` | — | Show help |

`car-to-tar.mts`:

| Flag | Description |
|---|---|
| `-o, --out PATH` | Output path (default `./<root-cid>.tar`) |
| `--stdout` | Write tar to stdout; logs go to stderr |
| `--root CID` | Override root CID (when CAR headers are missing/disagree) |

Files whose blocks can't be found are skipped with a `WARN` on stderr; the resulting tar is always valid. Exit codes: `0` on any extraction, `1` on setup failure, `2` if zero entries extracted.

## Troubleshooting

**"No credentials. Run with --login..."** — first-time setup; run `--login your@email.com` and click the email link.

**"No space found matching: ..."** — case-insensitive name match. Run `--list-spaces` to see the exact names; if you can't find the right one we try a "Did you mean: ..." suggestion based on edit distance.

**Long pause after "Fetching N uploads..."** — the script is downloading shards. With multiple-shard uploads you'll see one progress line per shard, including transfer rate.

**Some files are missing after extraction.** Storacha's indexing service occasionally has no usable storage location for some content (this is a real, persistent gap, not a flaky lookup). When this happens we still write everything we *can* recover, plus three sidecar files next to it under `./files/<space>/`:

- `<root>.warnings.txt` — partial extract: original filename + CID for each file that couldn't be retrieved
- `<root>.missing.txt` — total extract failure: same format, lists every child of the upload root
- `<root>.recover.sh` — runnable shell script that tries to fetch each missing file from the public IPFS gateway (`https://w3s.link/ipfs/<cid>`), which sometimes succeeds where our direct lookup didn't

To attempt recovery of an upload's missing files:

```bash
cd ./files/<space>
sh ./<root>.recover.sh   # creates files in the current directory; lines that fail print "FAILED <cid> <name>"
```

If the gateway also can't find a CID, that data is genuinely unreachable through the published API; the raw CARs in `./cars/` are still saved as the lowest-level backup in case storacha publishes a recovery tool later.

**Better-sqlite3 "Could not locate the bindings file"** — `npm install` should auto-rebuild it via the postinstall script, but if it doesn't, run `cd node_modules/better-sqlite3 && npm run build-release` to force a rebuild from source. Needs Python and a C++ compiler.

## Tests

```bash
npm test
```

Covers `car-to-tar` end-to-end against in-memory CARs. `storacha-export.mts` is not unit-tested — auth and the indexing service make it integration territory.

## License

AGPL-3.0-or-later

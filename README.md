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

# 5. download and extract everything from a space.
#    Files end up under ./files/<space>/.
npx tsx storacha-export.mts --space "MySpaceName" --extract
```

That's it. Your reconstructed files land under `./files/<space>/`. Raw CAR files (the on-disk format Storacha uses) stay in `./cars/` as a backup.

## What is this?

Two small standalone scripts:

- `storacha-export.mts` talks to Storacha, finds your data, and downloads it to `./cars/`. With `--extract`, it also reconstructs the original files into `./files/`.
- `car-to-tar.mts` is a pure file-format converter. It takes raw CAR files and emits a TAR archive of the directory tree they contain. No network, no Storacha-specific knowledge; useful for CAR files from any source.

The scripts run directly via `tsx`; there's no build step. State is kept in `./storacha-export.db` (SQLite) so a re-run resumes where it left off. Interrupt with Ctrl-C any time.

## Common flows

```bash
# Just one space, download only (no extraction; you get raw CARs)
npx tsx storacha-export.mts --space "MyArchive"

# All spaces, with extraction (can take a long time and a lot of disk)
npx tsx storacha-export.mts --all --extract

# Resume an interrupted run. Same command picks up where it left off.
npx tsx storacha-export.mts --space "MyArchive" --extract

# More parallel HTTP fetches if your network is fast
npx tsx storacha-export.mts --space "MyArchive" --extract --concurrency 6

# Convert raw CARs to a TAR archive (separately, no network)
npx tsx car-to-tar.mts cars/<upload-id>.shard-*.car -o myupload.tar
tar xf myupload.tar
```

## Authentication

`--login your@email.com` sends a confirmation link. Once you click it, the script saves credentials so subsequent runs need no flag.

Credentials are stored on disk:
- macOS: `~/Library/Preferences/w3access/storacha-export.json`
- Linux: `~/.config/w3access/storacha-export.json`

If you already use the official Storacha CLI (`@storacha/cli`'s `storacha login`), this script picks up that profile too, with no separate login needed.

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

### "No credentials. Run with --login..."
First-time setup. Run `--login your@email.com` and click the email link.

### "No space found matching: ..."
Case-insensitive name match. Run `--list-spaces` to see the exact names. If you mistype a name, the script tries a "Did you mean: ..." suggestion based on edit distance.

### Long pause after "Fetching N uploads..."
The script is downloading shards. With multiple-shard uploads you'll see one progress line per shard, including transfer rate.

### Some files are missing after extraction
Sometimes Storacha's indexing service has no usable storage location for an upload's content. The gap is in the indexing data itself, so a retry won't help. When this happens, the script still writes everything it can recover and drops a per-upload list of what's missing into `./files/<space>/<root>.missing.txt`. The format is one line per file, tab-separated:

```
<cid>	<filename>
```

A shipped helper script reads that list and tries each one through a public IPFS gateway (`https://w3s.link/ipfs/<cid>`), which sometimes succeeds where the direct lookup didn't:

```bash
# One upload at a time:
cd ./files/<space>
sh ../../recover.sh <root>.missing.txt

# Or batch every missing list across every space:
find ./files -name '*.missing.txt' | xargs -n1 sh ./recover.sh
```

For each entry the helper prints `OK <cid> <filename>` or `FAILED <cid> <filename>`, so you can grep results or re-run only the failures (edit the .missing.txt to drop lines you've already got). If the gateway can't find a CID either, that data isn't reachable through the published API; the raw CARs in `./cars/` stay around as a lowest-level backup in case storacha publishes a recovery tool later.

### Better-sqlite3 "Could not locate the bindings file"
`npm install` should auto-rebuild it via the postinstall script. If it doesn't, run `cd node_modules/better-sqlite3 && npm run build-release` to force a rebuild from source. Needs Python and a C++ compiler.

## Tests

```bash
npm test
```

Covers `car-to-tar` end-to-end against in-memory CARs. `storacha-export.mts` is not unit-tested. Auth and the indexing service make it integration territory.

## License

AGPL-3.0-or-later

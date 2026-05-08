#!/usr/bin/env npx tsx
/**
 * storacha-export: Download Storacha space content as CAR files,
 * optionally reconstructing the original file tree on disk.
 *
 * Clean standalone script — no dashboard, no kubo, no repair logic.
 * Resolves shards via indexing service, downloads from R2, writes to disk.
 *
 * Usage:
 *   npx tsx storacha-export.mts [--output /store/cars] [--space DataCivica] [--concurrency 3]
 *   npx tsx storacha-export.mts --list-spaces
 *   npx tsx storacha-export.mts --login your@email.com
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { detectCredentials, login } from './auth.mts'
import { convert } from './car-to-tar.mts'
import { CID } from 'multiformats/cid'
import { base58btc } from 'multiformats/bases/base58'
import { Client as IndexingClient } from '@storacha/indexing-service-client'
import { Agent } from 'undici'

// --- Config ---
const HELP = `Usage: storacha-export [options]

Download every upload in your Storacha spaces. By default produces CAR
files in ./cars; pass --extract to also reconstruct the original files
under ./files/<space>/.

Options:
  --space NAME        Download just one space (case-insensitive name)
  --all               Download every space (without this, --space is required)
  --extract           After download, extract files to ./files/<space>/<root>/
  --output PATH       Directory for shard CAR files (default: ./cars)
  --concurrency N     Parallel shard downloads (default: 3)
  --db PATH           SQLite progress DB (default: ./storacha-export.db)
  --list-spaces       Print spaces and exit
  --login EMAIL       Log in via email link, save credentials, exit
  -h, --help          Show this help

First-time setup:
  npx tsx storacha-export.mts --login your@email.com  (use the email
    your Storacha account is registered with — click the link in your inbox)
  npx tsx storacha-export.mts --list-spaces            (see what's there)
  npx tsx storacha-export.mts --space "MyArchive" --extract
`

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--output', '--space', '--concurrency', '--db', '--login'])
const BOOLEAN_FLAGS = new Set(['--list-spaces', '--extract', '--all', '-h', '--help'])

if (args.includes('-h') || args.includes('--help')) {
  process.stderr.write(HELP)
  process.exit(0)
}

// Validate args: reject unknown flags (silently ignoring them caused
// real confusion when a typo like --email made the script fall through
// to cached credentials with no warning).
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (BOOLEAN_FLAGS.has(a)) continue
  if (FLAGS_WITH_VALUE.has(a)) {
    if (!args[i + 1]) {
      console.error(`error: ${a} requires a value`)
      process.exit(1)
    }
    i++
    continue
  }
  if (a.startsWith('-')) {
    if (a === '--email') {
      console.error(`error: unknown flag --email; did you mean --login?`)
    } else {
      console.error(`error: unknown flag: ${a}`)
    }
    process.stderr.write('\n' + HELP)
    process.exit(1)
  }
  console.error(`error: unexpected positional argument: ${a}`)
  process.exit(1)
}

function arg(name: string, def: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const OUTPUT_DIR = arg('output', './cars')
const SPACE_FILTER = arg('space', '')
const CONCURRENCY = parseInt(arg('concurrency', '3'), 10)
// Default DB filename. If a legacy storacha-download.db sits in the
// cwd and the new name doesn't, fall back to the old one so users with
// existing resume state aren't reset by the script rename.
const DEFAULT_DB = (() => {
  const newName = './storacha-export.db'
  const oldName = './storacha-download.db'
  if (!fs.existsSync(newName) && fs.existsSync(oldName)) return oldName
  return newName
})()
const DB_PATH = arg('db', DEFAULT_DB)
const LIST_SPACES = args.includes('--list-spaces')
const LOGIN_EMAIL = arg('login', '')
const EXTRACT = args.includes('--extract')
const ALL = args.includes('--all')

// Long timeout for large shard downloads on slow disks
const fetchAgent = new Agent({ bodyTimeout: 600000, headersTimeout: 60000 })

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`${ts} ${msg}`)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n < 1024 ** 4) return `${(n / 1024 ** 3).toFixed(2)} GiB`
  return `${(n / 1024 ** 4).toFixed(2)} TiB`
}

// Guess a file extension from magic bytes. Returns empty string if
// nothing matches — caller falls back to no extension. Covers the
// common cases an archivist downloads: PDFs, images, video, archives,
// docs. Anything beyond that the user can `file <path>` themselves.
function guessExtension(filePath: string): string {
  const fd = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(16)
  try {
    fs.readSync(fd, buf, 0, 16, 0)
  } finally {
    fs.closeSync(fd)
  }
  const hex = buf.toString('hex')
  const ascii = buf.toString('ascii')
  if (ascii.startsWith('%PDF')) return '.pdf'
  if (hex.startsWith('89504e470d0a1a0a')) return '.png'
  if (hex.startsWith('ffd8ff')) return '.jpg'
  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) return '.gif'
  if (hex.startsWith('504b0304') || hex.startsWith('504b0506') || hex.startsWith('504b0708')) return '.zip'
  if (hex.startsWith('1f8b08')) return '.gz'
  if (hex.startsWith('425a68')) return '.bz2'
  if (hex.startsWith('fd377a585a00')) return '.xz'
  if (ascii.startsWith('OggS')) return '.ogg'
  if (ascii.startsWith('ID3') || hex.startsWith('fffb')) return '.mp3'
  // ftyp container — bytes 4..8 spell "ftyp"
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12)
    if (brand.startsWith('qt') || brand.startsWith('mov')) return '.mov'
    return '.mp4'
  }
  if (hex.startsWith('1a45dfa3')) return '.mkv'
  if (ascii.startsWith('RIFF')) {
    const sub = buf.toString('ascii', 8, 12)
    if (sub === 'WAVE') return '.wav'
    if (sub === 'AVI ') return '.avi'
    if (sub === 'WEBP') return '.webp'
  }
  // Office docs (xlsx/docx/pptx are ZIPs but starting with PK) — already caught above
  if (ascii.startsWith('<?xml') || ascii.startsWith('<!DOCTYPE')) return '.xml'
  // Plain text heuristic: high proportion of printable ASCII in first 16 bytes
  let printable = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if ((b >= 0x20 && b < 0x7f) || b === 0x09 || b === 0x0a || b === 0x0d) printable++
  }
  if (printable / buf.length > 0.85) return '.txt'
  return ''
}

// --- Login (if requested) ---
if (LOGIN_EMAIL) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(LOGIN_EMAIL)) {
    console.error(`error: --login expects an email address, got: ${LOGIN_EMAIL}`)
    process.exit(1)
  }
  log(`Sending login link to ${LOGIN_EMAIL}...`)
  log('Check your email and click the confirmation link. This may take a few minutes.')
  try {
    await login(LOGIN_EMAIL)
    log('Login confirmed. Credentials saved to the storacha-export profile.')
    log('You can now run storacha-export.mts without --login.')
    process.exit(0)
  } catch (err: any) {
    console.error(`login failed: ${err?.message ?? err}`)
    process.exit(1)
  }
}

// --- Auth ---
log('Authenticating...')
const creds = await detectCredentials()
if (!creds.hasCredentials) {
  console.error('No credentials. Run with --login your@email.com to log in.')
  process.exit(1)
}
const client = creds.client
const indexer = new IndexingClient()

const allSpaces: Array<{ did: string; name: string }> = client.spaces().map((s: any) => ({
  did: s.did(),
  name: s.name || '(unnamed)',
}))
const spaces = SPACE_FILTER
  ? allSpaces.filter(s => s.name.toLowerCase().trim() === SPACE_FILTER.toLowerCase().trim())
  : allSpaces

// --- List spaces and exit (if --list-spaces) ---
if (LIST_SPACES) {
  console.log(`Found ${allSpaces.length} space(s):`)
  for (const s of allSpaces) console.log(`  • ${s.name}`)

  // Try to fetch per-space sizes; gracefully degrade.
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const period = { from, to: now }
  const sizes = new Map<string, bigint>()
  for (const account of Object.values(client.accounts())) {
    try {
      const subs = await (account as any).capability.subscription.list((account as any).did())
      for (const { consumers } of subs.results) {
        for (const spaceDid of consumers) {
          if (!allSpaces.some(s => s.did === spaceDid)) continue
          try {
            const result = await client.capability.usage.report(spaceDid, period)
            let total = 0n
            for (const [, report] of Object.entries(result)) {
              total += BigInt((report as any)?.size?.final || 0)
            }
            sizes.set(spaceDid, total)
          } catch {}
        }
      }
    } catch {}
  }
  if (sizes.size > 0) {
    console.log('\nUsage (last month):')
    let totalBytes = 0n
    for (const s of allSpaces) {
      const size = sizes.get(s.did) ?? null
      if (size === null) continue
      totalBytes += size
      const gb = Number(size) / (1024 ** 3)
      console.log(`  ${s.name}: ${gb.toFixed(1)} GiB`)
    }
    const tb = Number(totalBytes) / (1024 ** 4)
    console.log(`  Total: ${tb.toFixed(2)} TiB`)
  }
  console.log('\nTo download one space:    --space "<name>" --extract')
  console.log('To download everything:   --extract')
  process.exit(0)
}

// Require explicit scope when downloading. Avoid silently downloading
// every space (potentially many TB) just because the user typed
// `npx tsx storacha-export.mts` to see what happens.
if (!SPACE_FILTER && !ALL) {
  console.log(`You have ${allSpaces.length} space(s). What would you like to do?\n`)
  console.log(`  See what's there:        --list-spaces`)
  console.log(`  Download one space:      --space "<name>" --extract`)
  console.log(`  Download everything:     --all --extract\n`)
  console.log(`(without --extract you get raw CAR files in ./cars; with --extract you also get reconstructed files in ./files)`)
  process.exit(0)
}

// Helpful error when --space doesn't match.
if (SPACE_FILTER && spaces.length === 0) {
  console.error(`No space found matching: "${SPACE_FILTER}"`)
  // Suggest closest by simple substring + case-insensitive name.
  const target = SPACE_FILTER.toLowerCase()
  const candidates = allSpaces
    .map(s => ({ s, name: s.name.toLowerCase() }))
    .filter(({ name }) => name.includes(target) || target.includes(name) || levenshtein(name, target) <= 3)
    .map(({ s }) => s.name)
  if (candidates.length > 0) {
    console.error(`Did you mean: ${candidates.slice(0, 5).map(c => `"${c}"`).join(', ')}?`)
  } else {
    console.error(`Run with --list-spaces to see all ${allSpaces.length} spaces.`)
  }
  process.exit(1)
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1])
    }
  }
  return dp[a.length][b.length]
}

log(`${spaces.length} space(s) to process`)

// --- DB setup ---
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.exec(`
  CREATE TABLE IF NOT EXISTS spaces (
    did TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    upload_count INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
    enumerated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS uploads (
    root_cid TEXT PRIMARY KEY,
    space_did TEXT NOT NULL,
    space_name TEXT,
    status TEXT DEFAULT 'pending',
    shard_count INTEGER DEFAULT 0,
    bytes_total INTEGER DEFAULT 0,
    inserted_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS shards (
    upload_root TEXT NOT NULL,
    shard_cid TEXT NOT NULL,
    location_url TEXT,
    shard_size INTEGER,
    shard_order INTEGER NOT NULL,
    space_did TEXT,
    PRIMARY KEY (upload_root, shard_cid)
  );
  CREATE TABLE IF NOT EXISTS files (
    upload_root TEXT NOT NULL,
    shard_order INTEGER NOT NULL,
    filename TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    downloaded_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (upload_root, shard_order)
  );
`)

const insertSpace = db.prepare(`INSERT OR REPLACE INTO spaces (did, name, upload_count, enumerated_at) VALUES (?, ?, ?, datetime('now'))`)
const insertUpload = db.prepare(`INSERT OR IGNORE INTO uploads (root_cid, space_did, space_name) VALUES (?, ?, ?)`)
const insertShard = db.prepare(`INSERT OR IGNORE INTO shards (upload_root, shard_cid, location_url, shard_size, shard_order, space_did) VALUES (?, ?, ?, ?, ?, ?)`)
const insertFile = db.prepare(`INSERT OR REPLACE INTO files (upload_root, shard_order, filename, bytes) VALUES (?, ?, ?, ?)`)
const markDone = db.prepare(`UPDATE uploads SET status = 'done', bytes_total = ?, updated_at = datetime('now') WHERE root_cid = ?`)
const markError = db.prepare(`UPDATE uploads SET status = 'error', updated_at = datetime('now') WHERE root_cid = ?`)
const markResolved = db.prepare(`UPDATE uploads SET shard_count = ?, updated_at = datetime('now') WHERE root_cid = ?`)
const getPendingAll = db.prepare(`SELECT * FROM uploads WHERE status = 'pending' AND shard_count > 0`)
const getPendingBySpace = db.prepare(`SELECT * FROM uploads WHERE status = 'pending' AND shard_count > 0 AND space_name = ?`)
const getUnresolved = db.prepare(`SELECT * FROM uploads WHERE shard_count = 0`)
const getUnresolvedBySpace = db.prepare(`SELECT * FROM uploads WHERE shard_count = 0 AND space_name = ?`)
const getShards = db.prepare(`SELECT * FROM shards WHERE upload_root = ? ORDER BY shard_order`)
const getStats = db.prepare(`SELECT status, count(*) as n FROM uploads GROUP BY status`)
const getStatsBySpace = db.prepare(`SELECT status, count(*) as n FROM uploads WHERE space_name = ? GROUP BY status`)
const getResolutionStats = db.prepare(`SELECT CASE WHEN shard_count = 0 THEN 'unresolved' ELSE 'resolved' END as state, count(*) as n FROM uploads WHERE status = 'pending' GROUP BY state`)
const getResolutionStatsBySpace = db.prepare(`SELECT CASE WHEN shard_count = 0 THEN 'unresolved' ELSE 'resolved' END as state, count(*) as n FROM uploads WHERE status = 'pending' AND space_name = ? GROUP BY state`)

// --- Phase 1: Enumerate uploads ---
for (const space of spaces) {
  const existing = db.prepare(`SELECT count(*) as n FROM uploads WHERE space_did = ?`).get(space.did) as any
  if (existing.n > 0) {
    log(`  ${space.name}: ${existing.n} uploads already enumerated`)
    continue
  }

  log(`  Enumerating ${space.name}...`)
  client.setCurrentSpace(space.did)
  let cursor: string | undefined
  let count = 0
  do {
    const page = await client.capability.upload.list({ cursor })
    const batch = db.transaction(() => {
      for (const upload of page.results) {
        insertUpload.run(upload.root.toString(), space.did, space.name)
      }
    })
    batch()
    count += page.results.length
    if (count % 500 === 0) log(`    ${space.name}: ${count} uploads found...`)
    cursor = page.cursor
  } while (cursor)
  insertSpace.run(space.did, space.name, count)
  log(`  ${space.name}: ${count} uploads`)
}

// --- Phase 2: Resolve shards (page-by-page like storacha/upload-service#694) ---
const unresolved = (SPACE_FILTER ? getUnresolvedBySpace.all(SPACE_FILTER) : getUnresolved.all()) as Array<{ root_cid: string; space_did: string; space_name: string }>
log(`Resolving shards for ${unresolved.length} uploads...`)

let resolved = 0
let resolveFailed = 0
let failedListShards = 0
let failedNoShards = 0
let failedNoClaims = 0

// Group by space for setCurrentSpace efficiency
const bySpace = new Map<string, typeof unresolved>()
for (const u of unresolved) {
  if (!bySpace.has(u.space_did)) bySpace.set(u.space_did, [])
  bySpace.get(u.space_did)!.push(u)
}

for (const [spaceDid, uploads] of bySpace) {
  client.setCurrentSpace(spaceDid)
  log(`  Resolving ${uploads.length} uploads in ${uploads[0].space_name}...`)

  // Process in pages of 20 (balance between batching and not blocking too long)
  for (let page = 0; page < uploads.length; page += 20) {
    const batch = uploads.slice(page, page + 20)

    // Step 1: list shards for each upload (serial to avoid event loop blocking)
    const uploadsWithShards: Array<{ root: string; shardLinks: any[] }> = []
    for (const u of batch) {
      try {
        const root = CID.parse(u.root_cid)
        const shardLinks: any[] = []
        let cur: string | undefined
        do {
          const result = await client.capability.upload.shard.list(root, { cursor: cur })
          shardLinks.push(...result.results)
          cur = result.cursor
        } while (cur)
        uploadsWithShards.push({ root: u.root_cid, shardLinks })
      } catch (err: any) {
        log(`  ✗ ${u.root_cid.slice(0, 24)}... shard.list failed: ${err?.message ?? err}`)
        failedListShards++
        resolveFailed++
      }
    }

    // Step 2: batch query claims for ALL shards in this page (one HTTP call)
    const allShardLinks = uploadsWithShards.flatMap(u => u.shardLinks)
    if (allShardLinks.length === 0) continue

    const hashes = allShardLinks.map((l: any) => l.multihash)
    let claimsMap = new Map<string, { url: string; size: number | null }>()

    try {
      const result = await indexer.queryClaims({ hashes, kind: 'standard' })
      if (result.ok) {
        for (const claim of result.ok.claims.values()) {
          if (claim.type !== 'assert/location') continue
          const bytes = 'digest' in claim.content ? claim.content.digest : claim.content.multihash?.bytes
          if (!bytes) continue
          const b58 = base58btc.encode(bytes)
          const url = claim.location?.[0]?.toString()
          if (!url) continue
          const size = claim.range?.length ?? null
          if (!claimsMap.has(b58)) claimsMap.set(b58, { url, size })
        }
      }
    } catch {}

    // Step 3: store resolved shards
    const failureNotes: string[] = []
    const storeBatch = db.transaction(() => {
      for (const { root, shardLinks } of uploadsWithShards) {
        if (shardLinks.length === 0) {
          failureNotes.push(`  ✗ ${root.slice(0, 24)}... no shards listed for this upload`)
          failedNoShards++
          resolveFailed++
          continue
        }
        let missing = 0
        for (let i = 0; i < shardLinks.length; i++) {
          const link = shardLinks[i]
          const b58 = base58btc.encode(link.multihash.bytes)
          const claim = claimsMap.get(b58)
          if (claim) {
            insertShard.run(root, link.toString(), claim.url, claim.size, i, spaceDid)
          } else {
            missing++
          }
        }
        if (missing === 0) {
          markResolved.run(shardLinks.length, root)
          resolved++
        } else {
          failureNotes.push(`  ✗ ${root.slice(0, 24)}... no location claim for ${missing}/${shardLinks.length} shard(s)`)
          failedNoClaims++
          resolveFailed++
        }
      }
    })
    storeBatch()
    for (const note of failureNotes) log(note)

    if ((page + 20) % 100 < 20) {
      log(`  ${page + batch.length}/${uploads.length} checked, ${resolved} resolved`)
    }
  }
}

// --- Phase 2B: URL-pattern fallback for uploads still unresolved ---
//
// Some uploads (notably older sharded uploads) don't have per-shard
// assert/location claims indexed. The upload root, however, often has
// an assert/location claim pointing at one of its shards' CARs in
// carpark-prod-N R2 with a regular path:
//
//   https://carpark-prod-N.r2.w3s.link/<shard-cid>/<shard-cid>.car
//
// Once we know the bucket from one shard's URL, we can construct URLs
// for every shard.list() entry without further indexer help.
const stillUnresolved = (SPACE_FILTER ? getUnresolvedBySpace.all(SPACE_FILTER) : getUnresolved.all()) as Array<{ root_cid: string; space_did: string; space_name: string }>

let fallbackResolved = 0
let fallbackFailed = 0

if (stillUnresolved.length > 0) {
  log(`Trying URL-pattern fallback for ${stillUnresolved.length} unresolved upload(s)...`)
  // Group by space for setCurrentSpace efficiency
  const fallbackBySpace = new Map<string, typeof stillUnresolved>()
  for (const u of stillUnresolved) {
    if (!fallbackBySpace.has(u.space_did)) fallbackBySpace.set(u.space_did, [])
    fallbackBySpace.get(u.space_did)!.push(u)
  }
  for (const [spaceDid, uploads] of fallbackBySpace) {
    client.setCurrentSpace(spaceDid)
    // Batch-query upload root multihashes for assert/location
    for (let page = 0; page < uploads.length; page += 100) {
      const batch = uploads.slice(page, page + 100)
      const rootHashes = batch.map(u => CID.parse(u.root_cid).multihash)
      const rootUrlMap = new Map<string, string>() // b58(root multihash) → url
      try {
        const result = await indexer.queryClaims({ hashes: rootHashes, kind: 'standard' })
        if (result.ok) {
          for (const claim of result.ok.claims.values()) {
            if (claim.type !== 'assert/location') continue
            const bytes = 'digest' in claim.content ? claim.content.digest : claim.content.multihash?.bytes
            if (!bytes) continue
            const url = claim.location?.[0]?.toString()
            if (!url) continue
            const b58 = base58btc.encode(bytes)
            if (!rootUrlMap.has(b58)) rootUrlMap.set(b58, url)
          }
        }
      } catch {}

      for (const u of batch) {
        const rootB58 = base58btc.encode(CID.parse(u.root_cid).multihash.bytes)
        const sampleUrl = rootUrlMap.get(rootB58)
        if (!sampleUrl) {
          // No root claim either — genuinely unresolvable.
          log(`  ✗ ${u.root_cid.slice(0, 24)}... no upload-root claim either; cannot construct URLs`)
          fallbackFailed++
          continue
        }
        // Extract bucket origin from the sample URL.
        const m = sampleUrl.match(/^(https?:\/\/[^/]+)\//)
        if (!m) {
          log(`  ✗ ${u.root_cid.slice(0, 24)}... unrecognised URL shape: ${sampleUrl}`)
          fallbackFailed++
          continue
        }
        const bucket = m[1]
        // Re-list shards (Phase 2A may have failed earlier; redo cheaply).
        let shardLinks: any[]
        try {
          const root = CID.parse(u.root_cid)
          shardLinks = []
          let cur: string | undefined
          do {
            const r = await client.capability.upload.shard.list(root, { cursor: cur })
            shardLinks.push(...r.results)
            cur = r.cursor
          } while (cur)
        } catch (err: any) {
          log(`  ✗ ${u.root_cid.slice(0, 24)}... shard.list failed: ${err?.message ?? err}`)
          fallbackFailed++
          continue
        }
        if (shardLinks.length === 0) {
          log(`  ✗ ${u.root_cid.slice(0, 24)}... no shards listed`)
          fallbackFailed++
          continue
        }
        // Construct one URL per shard using the bucket pattern.
        const storeBatch = db.transaction(() => {
          for (let i = 0; i < shardLinks.length; i++) {
            const s = shardLinks[i]
            const url = `${bucket}/${s.toString()}/${s.toString()}.car`
            insertShard.run(u.root_cid, s.toString(), url, null, i, spaceDid)
          }
          markResolved.run(shardLinks.length, u.root_cid)
        })
        storeBatch()
        log(`  ✓ ${u.root_cid.slice(0, 24)}... ${shardLinks.length} shards via URL pattern (${bucket})`)
        fallbackResolved++
      }
    }
  }
  log(`URL-pattern fallback: ${fallbackResolved} resolved, ${fallbackFailed} still unresolved`)
}

const totalResolveFailed = resolveFailed - fallbackResolved + fallbackFailed
if (totalResolveFailed > 0) {
  const parts: string[] = []
  if (failedListShards) parts.push(`${failedListShards} couldn't list shards`)
  if (failedNoShards) parts.push(`${failedNoShards} had no shards`)
  if (failedNoClaims - fallbackResolved > 0) parts.push(`${failedNoClaims - fallbackResolved} missing location claim`)
  log(`Shard resolution: ${resolved + fallbackResolved} resolved, ${totalResolveFailed} failed${parts.length ? ' (' + parts.join(', ') + ')' : ''}`)
} else {
  log(`Shard resolution: ${resolved + fallbackResolved} resolved, 0 failed`)
}

// --- Phase 3: Download shards ---
fs.mkdirSync(OUTPUT_DIR, { recursive: true })
const pending = (SPACE_FILTER ? getPendingBySpace.all(SPACE_FILTER) : getPendingAll.all()) as Array<{ root_cid: string; shard_count: number }>
log(`Fetching ${pending.length} uploads (${CONCURRENCY} concurrent)...`)

let downloaded = 0
let downloadFailed = 0
let totalBytes = 0
let idx = 0

async function worker(id: number) {
  while (idx < pending.length) {
    const upload = pending[idx++]
    const rootCid = upload.root_cid
    const shards = getShards.all(rootCid) as Array<{ location_url: string; shard_order: number }>

    // Skip if already downloaded
    const firstShard = path.join(OUTPUT_DIR, `${rootCid}.shard-0.car`)
    if (fs.existsSync(firstShard)) {
      markDone.run(0, rootCid)
      downloaded++
      continue
    }

    try {
      let uploadBytes = 0
      const t0 = Date.now()
      for (const shard of shards) {
        const shardStart = Date.now()
        const res = await fetch(shard.location_url, { dispatcher: fetchAgent } as any)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const carBytes = new Uint8Array(await res.arrayBuffer())
        uploadBytes += carBytes.length

        const filename = `${rootCid}.shard-${shard.shard_order}.car`
        const filePath = path.join(OUTPUT_DIR, filename)
        fs.writeFileSync(filePath, carBytes)
        insertFile.run(rootCid, shard.shard_order, filename, carBytes.length)

        // Per-shard progress for multi-shard uploads — silence between
        // start and finish on big uploads (10s of GB) made users think
        // the script had hung.
        if (shards.length > 1) {
          const elapsed = (Date.now() - shardStart) / 1000
          const rate = elapsed > 0 ? carBytes.length / elapsed : 0
          log(`[${id}]   shard ${shard.shard_order + 1}/${shards.length} ${formatBytes(carBytes.length)} in ${elapsed.toFixed(1)}s (${formatBytes(rate)}/s)`)
        }
      }
      markDone.run(uploadBytes, rootCid)
      downloaded++
      totalBytes += uploadBytes
      const totalElapsed = (Date.now() - t0) / 1000
      const avgRate = totalElapsed > 0 ? uploadBytes / totalElapsed : 0
      log(`[${id}] ✓ ${rootCid.slice(0, 24)}... ${shards.length} shards ${formatBytes(uploadBytes)} (avg ${formatBytes(avgRate)}/s) [${downloaded}/${pending.length}]`)
    } catch (err: any) {
      markError.run(rootCid)
      downloadFailed++
      log(`[${id}] ✗ ${rootCid.slice(0, 24)}... ${err.message}`)
    }
  }
}

const t0 = Date.now()
const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i))
await Promise.all(workers)
const elapsed = ((Date.now() - t0) / 1000).toFixed(0)

log(`\nComplete: ${downloaded} downloaded, ${downloadFailed} failed`)
log(`Total: ${formatBytes(totalBytes)} in ${elapsed}s`)

// --- Phase 4: Extract files (if --extract) ---
if (EXTRACT) {
  const FILES_DIR = './files'
  fs.mkdirSync(FILES_DIR, { recursive: true })
  log(`\nExtracting files into ${FILES_DIR}/...`)

  // Look at every upload that's status=done with shards on disk.
  const completed = (SPACE_FILTER
    ? db.prepare(`SELECT root_cid, space_name FROM uploads WHERE status='done' AND space_name = ?`).all(SPACE_FILTER)
    : db.prepare(`SELECT root_cid, space_name FROM uploads WHERE status='done'`).all()) as Array<{ root_cid: string; space_name: string }>

  let extractedCount = 0
  let extractFailed = 0
  for (const u of completed) {
    const shardPaths: string[] = []
    let i = 0
    while (true) {
      const p = path.join(OUTPUT_DIR, `${u.root_cid}.shard-${i}.car`)
      if (!fs.existsSync(p)) break
      shardPaths.push(p)
      i++
    }
    if (shardPaths.length === 0) {
      log(`  (no shards on disk for ${u.root_cid.slice(0, 24)}..., skipping)`)
      continue
    }

    const spaceDir = path.join(FILES_DIR, u.space_name.replace(/\//g, '_').trim() || 'unnamed')
    const outDir = path.join(spaceDir, u.root_cid)
    if (fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0) {
      log(`  ✓ already extracted: ${outDir}`)
      extractedCount++
      continue
    }
    fs.mkdirSync(outDir, { recursive: true })

    // 1) CARs → TAR (in memory, sort of — convert pools blocks)
    const tarPath = path.join(spaceDir, `${u.root_cid}.tar`)
    const tarStream = fs.createWriteStream(tarPath)
    const warnings: string[] = []
    try {
      const result = await convert({
        carPaths: shardPaths,
        out: tarStream,
        log: (m) => warnings.push(m),
      })
      tarStream.end()
      await new Promise<void>((resolve, reject) => {
        tarStream.on('finish', () => resolve())
        tarStream.on('error', reject)
      })

      if (result.extracted === 0) {
        log(`  ✗ ${u.root_cid.slice(0, 24)}... no files extracted — uploads of this shape (dir of single-block PDFs etc.) need leaf blocks the indexer doesn't expose; raw CARs are still in ${OUTPUT_DIR}/`)
        try { fs.unlinkSync(tarPath) } catch {}
        try { fs.rmdirSync(outDir) } catch {}
        // The warnings name every missing child — useful for recovery
        // attempts (try fetching each CID via a public IPFS gateway).
        if (warnings.length > 0) {
          const warningsPath = path.join(spaceDir, `${u.root_cid}.missing.txt`)
          fs.writeFileSync(warningsPath, warnings.join('\n') + '\n')
          log(`     ${warnings.length} missing children listed in ${warningsPath}`)
        }
        extractFailed++
        continue
      }

      // 2) TAR → directory tree via system tar (POSIX)
      await new Promise<void>((resolve, reject) => {
        const proc = spawn('tar', ['-xf', tarPath, '-C', outDir], { stdio: 'pipe' })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', reject)
        proc.on('close', (code) => {
          if (code === 0) resolve()
          else reject(new Error(`tar -xf exited ${code}: ${stderr.trim()}`))
        })
      })

      // 3) Single-file uploads come out as <root>/<root> with no name.
      // Flatten to <root>.<ext> with a magic-bytes type guess so the
      // file is recognisable instead of looking like a directory CID.
      let displayDest = outDir
      const items = fs.readdirSync(outDir)
      if (items.length === 1 && items[0] === u.root_cid) {
        const inner = path.join(outDir, items[0])
        const stat = fs.statSync(inner)
        if (stat.isFile()) {
          const ext = guessExtension(inner)
          const flatPath = path.join(spaceDir, `${u.root_cid}${ext}`)
          fs.renameSync(inner, flatPath)
          fs.rmdirSync(outDir)
          displayDest = flatPath
        }
      }

      // 4) Drop the intermediate .tar — the raw CARs in ./cars are the
      //    durable backup. Save warnings (if any) next to the extracted
      //    output so missing-block details are recoverable.
      try { fs.unlinkSync(tarPath) } catch {}
      const warningsPath = path.join(spaceDir, `${u.root_cid}.warnings.txt`)
      if (warnings.length > 0) {
        fs.writeFileSync(warningsPath, warnings.join('\n') + '\n')
      }

      const skipNote = result.skipped > 0 ? ` (${result.skipped} files skipped, missing blocks)` : ''
      log(`  ✓ ${u.space_name}/${u.root_cid.slice(0, 16)}... → ${displayDest} (${result.extracted} entries${skipNote})`)
      if (warnings.length > 0) {
        const samples = warnings.slice(0, 3)
        for (const w of samples) log(`    ${w}`)
        if (warnings.length > samples.length) log(`    ...and ${warnings.length - samples.length} more (see ${warningsPath})`)
      }
      extractedCount++
    } catch (err: any) {
      log(`  ✗ ${u.root_cid.slice(0, 24)}... extract failed: ${err?.message ?? err}`)
      extractFailed++
    }
  }

  log(`\nExtracted ${extractedCount} upload(s) to ${FILES_DIR}/${extractFailed > 0 ? `, ${extractFailed} failed` : ''}`)
  if (extractedCount > 0) {
    log(`Your files are under ${FILES_DIR}/<space>/<upload-cid>/`)
  }
}

log(`\nStatus${SPACE_FILTER ? ` (${SPACE_FILTER})` : ''}:`)
const statsRows = (SPACE_FILTER ? getStatsBySpace.all(SPACE_FILTER) : getStats.all()) as any[]
const resolutionRows = (SPACE_FILTER ? getResolutionStatsBySpace.all(SPACE_FILTER) : getResolutionStats.all()) as any[]
const resByState = Object.fromEntries(resolutionRows.map(r => [r.state, r.n]))
for (const row of statsRows) {
  if (row.status === 'pending') {
    const r = resByState.resolved ?? 0
    const u = resByState.unresolved ?? 0
    log(`  pending: ${row.n} (resolved: ${r}, unresolved: ${u})`)
  } else {
    log(`  ${row.status}: ${row.n}`)
  }
}

db.close()
process.exit(downloadFailed > 0 ? 1 : 0)

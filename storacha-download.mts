#!/usr/bin/env npx tsx
/**
 * storacha-download: Download all Storacha space content as CAR files.
 *
 * Clean standalone script — no dashboard, no kubo, no repair logic.
 * Resolves shards via indexing service, downloads from R2, writes to disk.
 *
 * Usage:
 *   npx tsx storacha-download.mts [--output /store/cars] [--space DataCivica] [--concurrency 3]
 *   npx tsx storacha-download.mts --list-spaces
 *   npx tsx storacha-download.mts --login your@email.com
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { detectCredentials, login } from './auth.mts'
import { CID } from 'multiformats/cid'
import { base58btc } from 'multiformats/bases/base58'
import { Client as IndexingClient } from '@storacha/indexing-service-client'
import { Agent } from 'undici'

// --- Config ---
const HELP = `Usage: storacha-download [options]

Download every upload in your Storacha spaces as CAR shards.

Options:
  --output PATH       Directory for shard CAR files (default: ./cars)
  --space NAME        Limit to a single space (case-insensitive)
  --concurrency N     Parallel shard downloads (default: 3)
  --db PATH           SQLite progress DB (default: ./storacha-download.db)
  --list-spaces       Print spaces (with sizes) and exit
  --login EMAIL       Log in via email link, save credentials, exit
  -h, --help          Show this help

First-run auth: run with --login your@email.com, click the link in your
inbox; subsequent runs need no flag.
`

const args = process.argv.slice(2)
const FLAGS_WITH_VALUE = new Set(['--output', '--space', '--concurrency', '--db', '--login'])
const BOOLEAN_FLAGS = new Set(['--list-spaces', '-h', '--help'])

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
const DB_PATH = arg('db', './storacha-download.db')
const LIST_SPACES = args.includes('--list-spaces')
const LOGIN_EMAIL = arg('login', '')

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
    log('You can now run storacha-download.mts without --login.')
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
  ? allSpaces.filter(s => s.name.toLowerCase() === SPACE_FILTER.toLowerCase())
  : allSpaces

// --- List spaces and exit (if --list-spaces) ---
if (LIST_SPACES) {
  console.log(`${spaces.length} space(s):`)
  for (const s of spaces) console.log(`  ${s.name} - ${s.did}`)

  // Per-space sizes via usage report (last full month → now)
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const period = { from, to: now }
  let totalBytes = 0n
  console.log('\nUsage:')
  for (const account of Object.values(client.accounts())) {
    try {
      const subs = await (account as any).capability.subscription.list((account as any).did())
      for (const { consumers } of subs.results) {
        for (const spaceDid of consumers) {
          const space = spaces.find(s => s.did === spaceDid)
          if (!space) continue
          try {
            const result = await client.capability.usage.report(spaceDid, period)
            let total = 0n
            for (const [, report] of Object.entries(result)) {
              total += BigInt((report as any)?.size?.final || 0)
            }
            totalBytes += total
            const gb = Number(total) / (1024 ** 3)
            console.log(`  ${space.name}: ${gb.toFixed(1)} GiB`)
          } catch {
            console.log(`  ${space.name}: (no access to usage)`)
          }
        }
      }
    } catch {}
  }
  const tb = Number(totalBytes) / (1024 ** 4)
  console.log(`\nTotal: ${tb.toFixed(2)} TiB`)
  process.exit(0)
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

if (resolveFailed > 0) {
  const parts: string[] = []
  if (failedListShards) parts.push(`${failedListShards} couldn't list shards`)
  if (failedNoShards) parts.push(`${failedNoShards} had no shards`)
  if (failedNoClaims) parts.push(`${failedNoClaims} missing location claim`)
  log(`Shard resolution: ${resolved} resolved, ${resolveFailed} failed (${parts.join(', ')})`)
} else {
  log(`Shard resolution: ${resolved} resolved, ${resolveFailed} failed`)
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
      for (const shard of shards) {
        const res = await fetch(shard.location_url, { dispatcher: fetchAgent } as any)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const carBytes = new Uint8Array(await res.arrayBuffer())
        uploadBytes += carBytes.length

        const filename = `${rootCid}.shard-${shard.shard_order}.car`
        const filePath = path.join(OUTPUT_DIR, filename)
        fs.writeFileSync(filePath, carBytes)
        insertFile.run(rootCid, shard.shard_order, filename, carBytes.length)
      }
      markDone.run(uploadBytes, rootCid)
      downloaded++
      totalBytes += uploadBytes
      log(`[${id}] ✓ ${rootCid.slice(0, 24)}... ${shards.length} shards ${formatBytes(uploadBytes)} [${downloaded}/${pending.length}]`)
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

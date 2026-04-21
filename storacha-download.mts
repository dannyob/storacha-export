#!/usr/bin/env npx tsx
/**
 * storacha-download: Download all Storacha space content as CAR files.
 *
 * Clean standalone script — no dashboard, no kubo, no repair logic.
 * Resolves shards via indexing service, downloads from R2, writes to disk.
 *
 * Usage:
 *   npx tsx storacha-download.mts [--output /store/cars] [--space DataCivica] [--concurrency 3]
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { detectCredentials } from './src/auth.js'
import { CID } from 'multiformats/cid'
import { base58btc } from 'multiformats/bases/base58'
import { Client as IndexingClient } from '@storacha/indexing-service-client'
import { Agent } from 'undici'

// --- Config ---
const args = process.argv.slice(2)
function arg(name: string, def: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const OUTPUT_DIR = arg('output', './cars')
const SPACE_FILTER = arg('space', '')
const CONCURRENCY = parseInt(arg('concurrency', '3'), 10)
const DB_PATH = arg('db', './storacha-download.db')

// Long timeout for large shard downloads on slow disks
const fetchAgent = new Agent({ bodyTimeout: 600000, headersTimeout: 60000 })

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
const getShards = db.prepare(`SELECT * FROM shards WHERE upload_root = ? ORDER BY shard_order`)
const getStats = db.prepare(`SELECT status, count(*) as n FROM uploads GROUP BY status`)

function log(msg: string) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`${ts} ${msg}`)
}

// --- Auth ---
log('Authenticating...')
const creds = await detectCredentials()
if (!creds.hasCredentials) { console.error('No credentials'); process.exit(1) }
const client = creds.client
const indexer = new IndexingClient()

const allSpaces: Array<{ did: string; name: string }> = client.spaces().map((s: any) => ({
  did: s.did(),
  name: s.name || '(unnamed)',
}))
const spaces = SPACE_FILTER
  ? allSpaces.filter(s => s.name.toLowerCase() === SPACE_FILTER.toLowerCase())
  : allSpaces

log(`${spaces.length} space(s) to process`)

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
const unresolved = getUnresolved.all() as Array<{ root_cid: string; space_did: string; space_name: string }>
log(`Resolving shards for ${unresolved.length} uploads...`)

let resolved = 0
let resolveFailed = 0

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
      } catch {
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
    const storeBatch = db.transaction(() => {
      for (const { root, shardLinks } of uploadsWithShards) {
        let allResolved = true
        for (let i = 0; i < shardLinks.length; i++) {
          const link = shardLinks[i]
          const b58 = base58btc.encode(link.multihash.bytes)
          const claim = claimsMap.get(b58)
          if (claim) {
            insertShard.run(root, link.toString(), claim.url, claim.size, i, spaceDid)
          } else {
            allResolved = false
          }
        }
        if (allResolved && shardLinks.length > 0) {
          markResolved.run(shardLinks.length, root)
          resolved++
        } else {
          resolveFailed++
        }
      }
    })
    storeBatch()

    if ((page + 20) % 100 < 20) {
      log(`  ${page + batch.length}/${uploads.length} checked, ${resolved} resolved`)
    }
  }
}

log(`Shard resolution: ${resolved} resolved, ${resolveFailed} failed`)

// --- Phase 3: Download shards ---
fs.mkdirSync(OUTPUT_DIR, { recursive: true })
const pending = (SPACE_FILTER ? getPendingBySpace.all(SPACE_FILTER) : getPendingAll.all()) as Array<{ root_cid: string; shard_count: number }>
log(`Downloading ${pending.length} uploads (${CONCURRENCY} concurrent)...`)

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
      const mb = (uploadBytes / 1024 / 1024).toFixed(0)
      log(`[${id}] ✓ ${rootCid.slice(0, 24)}... ${shards.length} shards ${mb} MiB [${downloaded}/${pending.length}]`)
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
log(`Total: ${(totalBytes / 1024 / 1024 / 1024).toFixed(1)} GiB in ${elapsed}s`)
log(`\nStatus:`)
for (const row of getStats.all() as any[]) {
  log(`  ${row.status}: ${row.n}`)
}

db.close()
process.exit(downloadFailed > 0 ? 1 : 0)

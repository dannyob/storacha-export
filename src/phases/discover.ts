import type Database from 'better-sqlite3'
import { log } from '../util/log.js'
import { filesize } from '../util/format.js'
import { cidFromBlobDigest, ShardStore } from '../core/shards.js'
import { parseIndexBlob } from '../core/index-parser.js'
import type { GatewayFetcher } from '../core/fetcher.js'

/**
 * Enumerate all uploads across selected spaces.
 * Yields { rootCid, spaceDid, spaceName } for each upload.
 */
export async function* enumerateUploads(
  client: any,
  spaces: Array<{ did: string; name: string }>,
): AsyncIterable<{ rootCid: string; spaceDid: string; spaceName: string }> {
  for (const space of spaces) {
    log('INFO', `Enumerating ${space.name}...`)
    client.setCurrentSpace(space.did)
    let cursor: string | undefined
    let count = 0

    do {
      const result = await client.capability.upload.list({ cursor })
      for (const upload of result.results) {
        yield {
          rootCid: upload.root.toString(),
          spaceDid: space.did,
          spaceName: space.name,
        }
      }
      count += result.results.length
      log('INFO', `  ${space.name}: ${count} uploads found...`)
      cursor = result.cursor
    } while (cursor)

    log('INFO', `  ${space.name}: ${count} total`)
  }
}

/**
 * Collect space sizes via usage report API.
 * Caches in DB — skips API calls on subsequent runs.
 */
export async function collectSpaceSizes(
  client: any,
  spaces: Array<{ did: string; name: string }>,
  db: Database.Database,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()

  // Check cache first
  const cached = db.prepare('SELECT did, total_bytes FROM spaces WHERE total_bytes > 0').all() as Array<{ did: string; total_bytes: number }>
  const cachedMap = new Map(cached.map(r => [r.did, r.total_bytes]))
  const allCached = spaces.every(s => cachedMap.has(s.did))

  if (allCached) {
    log('INFO', 'Using cached space sizes')
    for (const s of spaces) sizes.set(s.did, cachedMap.get(s.did)!)
    return sizes
  }

  log('INFO', 'Querying usage reports (this can be slow)...')
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const period = { from, to: now }

  try {
    for (const account of Object.values(client.accounts())) {
      const subs = await (account as any).capability?.subscription?.list?.((account as any).did()) ??
        await client.capability.subscription.list((account as any).did())
      for (const { consumers } of subs.results) {
        for (const spaceDid of consumers) {
          const space = spaces.find(s => s.did === spaceDid)
          if (!space) continue
          try {
            const result = await client.capability.usage.report(spaceDid, period)
            let total = 0
            for (const [, report] of Object.entries(result)) {
              total += (report as any)?.size?.final || 0
            }
            sizes.set(spaceDid, total)
            log('INFO', `  ${space.name}: ${filesize(total)}`)

            db.prepare(
              `INSERT INTO spaces (did, name, total_bytes, enumerated_at) VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(did) DO UPDATE SET total_bytes = ?, enumerated_at = datetime('now')`
            ).run(spaceDid, space.name, total, total)
          } catch {
            log('INFO', `  ${space.name}: skipped (no access)`)
          }
        }
      }
    }
  } catch {
    log('INFO', 'Could not collect sizes')
  }

  return sizes
}

/**
 * Enumerate blobs via blob.list(), identify and parse index blobs,
 * and populate the shards table with upload->shard mappings.
 */
export async function discoverShards(
  client: any,
  spaces: Array<{ did: string; name: string }>,
  store: ShardStore,
  fetcher: GatewayFetcher,
): Promise<void> {
  for (const space of spaces) {
    log('INFO', `Discovering shards for ${space.name}...`)
    client.setCurrentSpace(space.did)
    let cursor: string | undefined
    let blobCount = 0

    do {
      const result = await client.capability.blob.list({ size: 1000, cursor })
      for (const entry of result.results) {
        const digestHex = Array.from(entry.blob.digest as Uint8Array)
          .map((b: number) => b.toString(16).padStart(2, '0')).join('')
        const cid = cidFromBlobDigest(entry.blob.digest)
        if (!cid) continue

        store.insertBlob({
          digest: digestHex,
          size: entry.blob.size,
          spaceDid: space.did,
          cid: cid.toString(),
          insertedAt: entry.insertedAt || '',
        })
        blobCount++
      }
      cursor = result.cursor
    } while (cursor)

    log('INFO', `  ${space.name}: ${blobCount} blobs`)

    const candidates = store.getUnfetchedCandidateIndexes(space.did)
    let indexCount = 0
    let multiShardCount = 0

    for (const blob of candidates) {
      try {
        const res = await fetcher.fetchShard(blob.cid)
        const bytes = new Uint8Array(await res.arrayBuffer())
        const result = await parseIndexBlob(bytes)

        if (result) {
          store.markFetched(blob.cid, space.did, true)
          for (let i = 0; i < result.shardCids.length; i++) {
            store.insertShard({
              uploadRoot: result.contentRoot,
              shardCid: result.shardCids[i],
              shardSize: null,
              shardOrder: i,
              spaceDid: space.did,
            })
          }
          indexCount++
          if (result.shardCids.length > 1) multiShardCount++
        } else {
          store.markFetched(blob.cid, space.did, false)
        }
      } catch (err: any) {
        log('WARN', `  Failed to fetch/parse blob ${blob.cid.slice(0, 20)}...: ${err.message}`)
        store.markFetched(blob.cid, space.did, false)
      }
    }

    store.updateShardSizes()
    log('INFO', `  ${space.name}: ${indexCount} indexes parsed, ${multiShardCount} multi-shard uploads`)
  }
}

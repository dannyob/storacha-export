import type Database from 'better-sqlite3'
import { log } from '../util/log.js'
import { filesize } from '../util/format.js'

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

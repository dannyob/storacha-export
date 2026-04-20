import { base58btc } from 'multiformats/bases/base58'
import { CID } from 'multiformats/cid'
import type { ShardInput } from './shards.js'
import { log } from '../util/log.js'

export interface IndexingService {
  queryClaims(opts: { hashes: any[]; kind?: string }): Promise<{ ok?: { claims: Map<string, any> } }>
}

/**
 * Resolve shards for an upload using upload.shard.list and the indexing service.
 * Returns null if no shards or no location claims found.
 */
export async function resolveUploadShards(
  rootCid: string,
  client: any,
  indexer: IndexingService,
): Promise<ShardInput[] | null> {
  // Paginate all shards for this upload
  const root = CID.parse(rootCid)
  const shardLinks: any[] = []
  let cursor: string | undefined
  do {
    const page = await client.capability.upload.shard.list(root, { cursor })
    shardLinks.push(...page.results)
    cursor = page.cursor
  } while (cursor)

  if (shardLinks.length === 0) return null

  // Build b58 → shard index for lookup
  const b58ToIdx = new Map<string, number>()
  const hashes: any[] = []
  for (let i = 0; i < shardLinks.length; i++) {
    const link = shardLinks[i]
    const b58 = base58btc.encode(link.multihash.bytes)
    b58ToIdx.set(b58, i)
    hashes.push(link.multihash)
  }

  // Batch query claims
  const claimsResult = await indexer.queryClaims({ hashes, kind: 'standard' })
  if (!claimsResult.ok) return null

  // Extract location URLs
  const locationUrls = new Map<number, { url: string; size: number | null }>()
  for (const claim of claimsResult.ok.claims.values()) {
    if (claim.type !== 'assert/location') continue
    const bytes = 'digest' in claim.content
      ? claim.content.digest
      : claim.content.multihash?.bytes
    if (!bytes) continue

    const b58 = base58btc.encode(bytes)
    const idx = b58ToIdx.get(b58)
    if (idx === undefined) continue
    if (locationUrls.has(idx)) continue

    const url = claim.location?.[0]?.toString()
    if (!url) continue

    const size = claim.range?.length ?? null
    locationUrls.set(idx, { url, size })
  }

  // Need location URLs for all shards
  if (locationUrls.size < shardLinks.length) {
    const missing = shardLinks.length - locationUrls.size
    log('INFO', `[${rootCid.slice(0, 24)}...] Missing location claims for ${missing}/${shardLinks.length} shards`)
    return null
  }

  // Build ordered shard list
  const result: ShardInput[] = []
  for (let i = 0; i < shardLinks.length; i++) {
    const loc = locationUrls.get(i)!
    result.push({
      shardCid: shardLinks[i].toString(),
      locationUrl: loc.url,
      size: loc.size,
      order: i,
    })
  }

  return result
}

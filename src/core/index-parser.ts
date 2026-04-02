import { CarBlockIterator } from '@ipld/car'
import * as dagCBOR from '@ipld/dag-cbor'

const DAG_CBOR_CODEC = 0x71

export interface IndexBlobResult {
  contentRoot: string
  shardCids: string[]
}

/**
 * Attempt to parse raw CAR bytes as a Storacha index blob.
 * Returns the content root and shard CID list if the CAR contains
 * a dag-cbor block with the `index/sharded/dag@0.1` key.
 * Returns null if this is not an index blob or parsing fails.
 */
export async function parseIndexBlob(carBytes: Uint8Array): Promise<IndexBlobResult | null> {
  try {
    const iterator = await CarBlockIterator.fromIterable(
      (async function* () { yield carBytes })()
    )

    for await (const { cid, bytes } of iterator) {
      if (cid.code !== DAG_CBOR_CODEC) continue

      const decoded = dagCBOR.decode(bytes) as Record<string, any>
      const index = decoded['index/sharded/dag@0.1']
      if (!index) continue

      const contentRoot = String(index.content)
      const shardCids = (index.shards as any[]).map(s => String(s))

      if (!contentRoot || shardCids.length === 0) continue

      return { contentRoot, shardCids }
    }

    return null
  } catch {
    return null
  }
}

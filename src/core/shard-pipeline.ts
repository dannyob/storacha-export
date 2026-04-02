import { CarBlockIterator } from '@ipld/car'
import type { GatewayFetcher } from './fetcher.js'
import type { ShardStore } from './shards.js'
import type { UploadQueue } from './queue.js'
import type { ExportBackend } from '../backends/interface.js'
import type { Block } from './blocks.js'
import { log } from '../util/log.js'

export interface ShardExportOptions {
  rootCid: string
  backend: ExportBackend
  queue: UploadQueue
  shardStore: ShardStore
  fetcher: GatewayFetcher
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

/**
 * Export an upload by fetching its individual shards and streaming
 * all blocks into the backend as a single combined BlockStream.
 */
export async function exportUploadViaShards(options: ShardExportOptions): Promise<void> {
  const { rootCid, backend, queue, shardStore, fetcher, onProgress } = options
  const tag = `[${rootCid.slice(0, 24)}...]`

  // Check if already complete
  const initialCheck = await backend.verifyDag(rootCid)
  if (initialCheck.valid) {
    queue.markComplete(rootCid, backend.name, 0)
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    log('INFO', `${tag} Already complete in ${backend.name}`)
    return
  }

  const shards = shardStore.getShardsForUpload(rootCid)
  if (shards.length === 0) {
    queue.markError(rootCid, backend.name, 'No shards found')
    return
  }

  queue.setStatus(rootCid, backend.name, 'downloading')
  onProgress?.({ type: 'downloading', rootCid })
  log('INFO', `${tag} Fetching ${shards.length} shard(s)`)

  let totalBytes = 0

  async function* shardBlockStream(): AsyncIterable<Block> {
    for (const shard of shards) {
      const res = await fetcher.fetchShard(shard.shard_cid)
      const bytes = new Uint8Array(await res.arrayBuffer())
      totalBytes += bytes.length

      const iterator = await CarBlockIterator.fromIterable(
        (async function* () { yield bytes })()
      )

      for await (const block of iterator) {
        yield block
      }

      onProgress?.({ type: 'progress', rootCid, bytes: totalBytes })
      log('INFO', `${tag} Shard ${shard.shard_order + 1}/${shards.length} done (${bytes.length} bytes)`)
    }
  }

  try {
    await backend.importCar(rootCid, shardBlockStream())

    const verifyResult = await backend.verifyDag(rootCid)
    if (verifyResult.valid) {
      queue.markComplete(rootCid, backend.name, totalBytes)
      onProgress?.({ type: 'done', rootCid, bytes: totalBytes })
      log('INFO', `${tag} Complete via shards`)
      return
    }

    queue.markError(rootCid, backend.name, verifyResult.error || 'DAG verification failed after shard import')
    onProgress?.({ type: 'error', rootCid, error: verifyResult.error })
  } catch (err: any) {
    queue.markError(rootCid, backend.name, err.message)
    onProgress?.({ type: 'error', rootCid, error: err.message })
  }
}

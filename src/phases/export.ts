import { exportUpload } from '../core/pipeline.js'
import { GatewayFetcher } from '../core/fetcher.js'
import type { UploadQueue } from '../core/queue.js'
import type { BlockManifest } from '../core/manifest.js'
import type { ShardStore } from '../core/shards.js'
import type { ExportBackend } from '../backends/interface.js'
import { log } from '../util/log.js'

export interface ExportOptions {
  queue: UploadQueue
  manifest: BlockManifest
  backends: ExportBackend[]
  gatewayUrl: string
  concurrency?: number
  spaceNames?: string[]
  shardStore?: ShardStore
  skipRepair?: boolean
  createFetcher?: (gatewayUrl: string) => GatewayFetcher
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

export async function runExport(options: ExportOptions): Promise<void> {
  const { queue, manifest, backends, gatewayUrl, concurrency = 1, spaceNames, createFetcher = (url) => new GatewayFetcher(url), onProgress } = options
  const fetcher = createFetcher(gatewayUrl)

  for (const backend of backends) {
    const requeued = queue.requeueCompleteWithMissing(backend.name)
    if (requeued > 0) {
      log('INFO', `Requeued ${requeued} complete ${backend.name} job(s) with manifest debt`)
    }
  }

  // Collect uploads pending for any backend (union)
  const pendingByRoot = new Map<string, { root_cid: string; space_name: string; space_did: string }>()
  for (const backend of backends) {
    const pending = spaceNames
      ? queue.getPendingForSpaces(backend.name, spaceNames)
      : queue.getPending(backend.name)
    log('INFO', `${pending.length} pending jobs for ${backend.name}`)
    for (const upload of pending) {
      if (!pendingByRoot.has(upload.root_cid)) {
        pendingByRoot.set(upload.root_cid, upload)
      }
    }
  }

  const pending = Array.from(pendingByRoot.values())
  log('INFO', `${pending.length} unique uploads to export across ${backends.length} backend(s)`)

  if (pending.length === 0) {
    onProgress?.({ type: 'export-complete' })
    return
  }

  let idx = 0

  async function worker() {
    while (idx < pending.length) {
      const upload = pending[idx++]
      onProgress?.({ type: 'downloading', rootCid: upload.root_cid, spaceName: upload.space_name })
      await exportUpload({
        rootCid: upload.root_cid,
        backends,
        queue,
        manifest,
        fetcher,
        gatewayUrl,
        shardStore: options.shardStore,
        skipRepair: options.skipRepair,
        onProgress: onProgress && ((info) => onProgress({ ...info, spaceName: upload.space_name })),
      })
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  onProgress?.({ type: 'export-complete' })
}

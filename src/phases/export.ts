import { exportUpload } from '../core/pipeline.js'
import type { UploadQueue } from '../core/queue.js'
import type { BlockManifest } from '../core/manifest.js'
import type { ExportBackend } from '../backends/interface.js'
import { log } from '../util/log.js'

export interface ExportOptions {
  queue: UploadQueue
  manifest: BlockManifest
  backends: ExportBackend[]
  gatewayUrl: string
  concurrency?: number
  spaceNames?: string[]
  onProgress?: (info: { type: string; [key: string]: any }) => void
  shouldPause?: () => boolean
}

export async function runExport(options: ExportOptions): Promise<void> {
  const { queue, manifest, backends, gatewayUrl, concurrency = 1, spaceNames, onProgress, shouldPause } = options

  for (const backend of backends) {
    const pending = spaceNames
      ? queue.getPendingForSpaces(backend.name, spaceNames)
      : queue.getPending(backend.name)

    log('INFO', `${pending.length} pending jobs for ${backend.name}`)

    if (pending.length === 0) continue

    let idx = 0

    async function worker() {
      while (idx < pending.length) {
        const upload = pending[idx++]
        onProgress?.({ type: 'downloading', rootCid: upload.root_cid, spaceName: upload.space_name })
        await exportUpload({
          rootCid: upload.root_cid,
          backend,
          queue,
          manifest,
          gatewayUrl,
          onProgress: onProgress && ((info) => onProgress({ ...info, spaceName: upload.space_name })),
          shouldPause,
        })
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker())
    await Promise.all(workers)
  }

  onProgress?.({ type: 'export-complete' })
}

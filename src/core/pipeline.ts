import { GatewayFetcher } from './fetcher.js'
import { trackBlocks } from './blocks.js'
import { repairUpload } from './repair.js'
import type { UploadQueue } from './queue.js'
import type { BlockManifest } from './manifest.js'
import type { ExportBackend } from '../backends/interface.js'
import { log } from '../util/log.js'

export interface ExportUploadOptions {
  rootCid: string
  backend: ExportBackend
  queue: UploadQueue
  manifest: BlockManifest
  gatewayUrl: string
  maxRetries?: number
  uploadTimeout?: number
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${Math.round(ms / 1000)}s: ${label}`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export async function exportUpload(options: ExportUploadOptions): Promise<void> {
  const { rootCid, backend, queue, manifest, gatewayUrl, maxRetries = 3, uploadTimeout = 300000, onProgress } = options
  const tag = `[${rootCid.slice(0, 24)}...]`
  const fetcher = new GatewayFetcher(gatewayUrl)

  // Check if we already have partial manifest data — skip straight to repair
  const existingProgress = manifest.getProgress(rootCid)
  if (existingProgress.total > 0 && existingProgress.missing > 0 && manifest.isRepairable(rootCid)) {
    log('INFO', `${tag} Resuming repair: ${existingProgress.seen}/${existingProgress.total} blocks, ${existingProgress.missing} missing`)
    queue.setStatus(rootCid, backend.name, 'repairing')
    onProgress?.({ type: 'repairing', rootCid })

    const result = await repairUpload(
      rootCid,
      manifest,
      (cidStr) => fetcher.fetchBlock(cidStr),
      {
        hasBlock: backend.hasBlock?.bind(backend),
        onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
      },
    )

    if (result && result.complete) {
      for (const block of result.blocks) {
        if (backend.putBlock) {
          await backend.putBlock(block.cid.toString(), block.bytes)
        }
      }
      if (await backend.hasContent(rootCid)) {
        queue.markComplete(rootCid, backend.name, 0)
        onProgress?.({ type: 'done', rootCid, bytes: 0 })
        log('REPAIR', `${tag} Repaired and verified`)
        return
      }
    }

    // Repair failed — fall through to full download as last resort
    log('INFO', `${tag} Repair incomplete, trying full CAR download`)
  }

  queue.setStatus(rootCid, backend.name, 'downloading')

  // Attempt to download the full CAR
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const rawBlocks = await fetcher.fetchCar(rootCid)
      const tracked = trackBlocks(rawBlocks, rootCid, manifest)

      // Count bytes and report progress as they flow through
      let byteCount = 0
      let blockCount = 0
      const counted = (async function* () {
        for await (const block of tracked) {
          byteCount += block.bytes.length
          blockCount++
          if (blockCount % 10 === 0) {
            const progress = manifest.getProgress(rootCid)
            onProgress?.({ type: 'progress', rootCid, bytes: byteCount, blocks: blockCount, totalBlocks: progress.total || undefined })
          }
          yield block
        }
      })()

      await withTimeout(
        backend.importCar(rootCid, counted),
        uploadTimeout,
        `CAR download ${rootCid.slice(0, 24)}...`,
      )

      // Success — verify it's pinned
      if (await backend.hasContent(rootCid)) {
        queue.markComplete(rootCid, backend.name, byteCount)
        onProgress?.({ type: 'done', rootCid, bytes: byteCount })
        return
      }

      // Import succeeded but pin failed — mark partial, will repair
      queue.setStatus(rootCid, backend.name, 'partial')
      lastError = new Error('Import succeeded but root not pinned')
      break

    } catch (err: any) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid, attempt, delay, error: err.message })
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  // Download failed — check if we got partial data
  const progress = manifest.getProgress(rootCid)
  if (progress.total > 0) {
    queue.setStatus(rootCid, backend.name, 'partial')
    log('INFO', `${tag} Partial: ${progress.seen}/${progress.total} blocks`)
  }

  // Attempt inline repair
  if (progress.total > 0 && manifest.isRepairable(rootCid)) {
    queue.setStatus(rootCid, backend.name, 'repairing')
    onProgress?.({ type: 'repairing', rootCid })

    const result = await repairUpload(
      rootCid,
      manifest,
      (cidStr) => fetcher.fetchBlock(cidStr),
      {
        hasBlock: backend.hasBlock?.bind(backend),
        onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
      },
    )

    if (result && result.complete) {
      // Push repaired blocks to backend
      for (const block of result.blocks) {
        if (backend.putBlock) {
          await backend.putBlock(block.cid.toString(), block.bytes)
        }
      }

      // Verify
      if (await backend.hasContent(rootCid)) {
        queue.markComplete(rootCid, backend.name, 0)
        onProgress?.({ type: 'done', rootCid, bytes: 0 })
        log('REPAIR', `${tag} Repaired and verified`)
        return
      }
    }
  }

  // All attempts failed
  queue.markError(rootCid, backend.name, lastError?.message || 'unknown error')
  onProgress?.({ type: 'error', rootCid, error: lastError?.message })
}

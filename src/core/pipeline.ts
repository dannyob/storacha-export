import { Readable, PassThrough } from 'node:stream'
import { CarBlockIterator } from '@ipld/car'
import * as dagPB from '@ipld/dag-pb'
import { GatewayFetcher } from './fetcher.js'
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
  // Quick check: if backend already has it pinned, skip everything
  if (await backend.hasContent(rootCid)) {
    queue.markComplete(rootCid, backend.name, 0)
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    log('INFO', `${tag} Already pinned in ${backend.name}`)
    return
  }

  const existingProgress = manifest.getProgress(rootCid)
  if (existingProgress.total > 0 && existingProgress.missing > 0) {
    log('INFO', `${tag} Resuming repair: ${existingProgress.seen}/${existingProgress.total} blocks, ${existingProgress.missing} missing`)
    queue.setStatus(rootCid, backend.name, 'repairing')
    onProgress?.({ type: 'repairing', rootCid, totalBlocks: existingProgress.missing })

    const result = await repairUpload(
      rootCid,
      manifest,
      (cidStr) => fetcher.fetchBlock(cidStr),
      {
        onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
        onBlock: async (block) => { if (backend.putBlock) await backend.putBlock(block.cid.toString(), block.bytes) },
      },
    )

    if (result && result.complete) {
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

  // Attempt to download the full CAR — stream raw bytes directly to backend
  let lastError: Error | undefined
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const abortController = new AbortController()
    let cleanupStreams: (() => void) | undefined

    try {
      const url = `${gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
      const res = await fetch(url, {
        dispatcher: fetcher.dispatcher,
        signal: abortController.signal,
      } as any)

      if (!res.ok) {
        await res.body?.cancel()
        if (res.status === 429 || res.status >= 500) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
          onProgress?.({ type: 'retry', rootCid, attempt, delay, error: `HTTP ${res.status}` })
          await new Promise(r => setTimeout(r, delay))
          continue
        }
        throw new Error(`Gateway returned ${res.status}: ${res.statusText}`)
      }

      // Stream raw CAR bytes to backend, tee a copy for block tracking
      const nodeStream = Readable.fromWeb(res.body! as any)
      let byteCount = 0
      let trackedBlocks = 0
      let trackedTotal: number | undefined
      let lastProgressTime = Date.now()
      const countingStream = new PassThrough({
        transform(chunk, _encoding, callback) {
          byteCount += chunk.length
          const now = Date.now()
          if (now - lastProgressTime > 3000) {
            onProgress?.({ type: 'progress', rootCid, bytes: byteCount, blocks: trackedBlocks, totalBlocks: trackedTotal })
            lastProgressTime = now
          }
          callback(null, chunk)
        },
      })

      const backendStream = new PassThrough()
      const trackingStream = new PassThrough({ highWaterMark: 1024 * 1024 })

      nodeStream.on('error', (err) => countingStream.destroy(err))
      backendStream.on('error', () => {})
      trackingStream.on('error', () => {})
      countingStream.on('error', () => { backendStream.destroy(); trackingStream.destroy() })

      nodeStream.pipe(countingStream)
      countingStream.pipe(backendStream)
      countingStream.pipe(trackingStream)

      cleanupStreams = () => {
        abortController.abort()
        nodeStream.destroy()
        countingStream.destroy()
        backendStream.destroy()
        trackingStream.destroy()
      }

      // Track blocks in parallel — if tracking fails/stalls, unpipe it so backend isn't blocked
      const trackingPromise = (async () => {
        try {
          const iterator = await CarBlockIterator.fromIterable(trackingStream)
          for await (const { cid, bytes } of iterator) {
            const cidStr = cid.toString()
            manifest.markSeen(rootCid, cidStr, cid.code)
            if (cid.code === 0x70) {
              try {
                const node = dagPB.decode(bytes)
                for (const link of node.Links) {
                  manifest.addLink(rootCid, link.Hash.toString(), link.Hash.code, cidStr)
                }
              } catch {}
            }
            trackedBlocks++
            if (trackedBlocks % 100 === 0) {
              trackedTotal = manifest.getProgress(rootCid).total || undefined
            }
          }
        } catch {
          // Truncated or error
        } finally {
          // Critical: unpipe so backend stream isn't blocked if tracking exits early
          countingStream.unpipe(trackingStream)
          trackingStream.destroy()
        }
      })()

      await withTimeout(
        backend.importCar(rootCid, backendStream as any),
        uploadTimeout,
        `CAR download ${rootCid.slice(0, 24)}...`,
      )

      // Don't await trackingPromise — if backend finished, tracking can finish in background
      trackingPromise.catch(() => {})

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
      cleanupStreams?.()
      if (attempt < maxRetries) {
        // Reset seen flags between retries — tee may have recorded blocks the backend didn't get
        // But keep DAG links so next attempt's tracking builds on known structure
        manifest.resetSeen(rootCid)
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid, attempt, delay, error: err.message })
        await new Promise(r => setTimeout(r, delay))
      }
      // On last attempt: keep manifest with seen flags — inline repair needs to know what's missing
    }
  }

  // Download failed — check if we got partial data
  const progress = manifest.getProgress(rootCid)
  if (progress.total > 0) {
    queue.setStatus(rootCid, backend.name, 'partial')
    const missingPB = manifest.getMissingDagPB(rootCid).length
    log('INFO', `${tag} Partial: ${progress.seen}/${progress.total} blocks (${progress.missing} missing, ${missingPB} dag-pb)`)
  }

  // Attempt inline repair — even with missing dag-pb, we can fetch them individually
  if (progress.total > 0 && progress.missing > 0) {
    queue.setStatus(rootCid, backend.name, 'repairing')
    onProgress?.({ type: 'repairing', rootCid, totalBlocks: progress.missing })

    const result = await repairUpload(
      rootCid,
      manifest,
      (cidStr) => fetcher.fetchBlock(cidStr),
      {
        onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
        onBlock: async (block) => { if (backend.putBlock) await backend.putBlock(block.cid.toString(), block.bytes) },
      },
    )

    if (result && result.complete) {
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

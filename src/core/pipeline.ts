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
  fetcher: GatewayFetcher
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
  const { rootCid, backend, queue, manifest, fetcher, gatewayUrl, maxRetries = 3, uploadTimeout = 300000, onProgress } = options
  const tag = `[${rootCid.slice(0, 24)}...]`
  let lastError: Error | undefined

  const existingProgress = manifest.getProgress(rootCid)
  if (existingProgress.total > 0 && existingProgress.missing > 0) {
    log('INFO', `${tag} Resuming repair: ${existingProgress.seen}/${existingProgress.total} blocks, ${existingProgress.missing} missing`)
    queue.setStatus(rootCid, backend.name, 'repairing')
    onProgress?.({ type: 'repairing', rootCid, totalBlocks: existingProgress.missing })

    // Generic repair: fetch missing blocks individually
    {
      const result = await repairUpload(
        rootCid,
        manifest,
        (cidStr) => fetcher.fetchBlock(cidStr),
        {
          onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
          onBlock: backend.putBlock ? async (block) => { await backend.putBlock!(block.cid.toString(), block.bytes, rootCid) } : undefined,
          fetchSubCar: (cid) => fetcher.fetchCar(cid),
        },
      )

      if (result && result.complete) {
        // Merge repair sidecar for local backend
        if ('mergeRepairCar' in backend) {
          await (backend as any).mergeRepairCar(rootCid)
        }

        const verifyResult = await backend.verifyDag(rootCid)
        if (verifyResult.valid) {
          queue.markComplete(rootCid, backend.name, 0)
          onProgress?.({ type: 'done', rootCid, bytes: 0 })
          log('REPAIR', `${tag} Repaired and verified`)
          return
        }

        queue.setStatus(rootCid, backend.name, 'partial')
        lastError = new Error(verifyResult.error || 'DAG verification failed after repair')
      }
    }

    // Repair failed — fall through to full download as last resort
    log('INFO', `${tag} Repair incomplete, trying full CAR download`)
  }

  const initialCheck = await backend.verifyDag(rootCid)
  if (initialCheck.valid) {
    queue.markComplete(rootCid, backend.name, 0)
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    log('INFO', `${tag} Already complete in ${backend.name}`)
    return
  }

  queue.setStatus(rootCid, backend.name, 'downloading')

  // Attempt to download the full CAR — stream raw bytes directly to backend
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const abortController = new AbortController()
    let cleanupStreams: (() => void) | undefined
    let trackingPromise: Promise<void> | undefined

    try {
      // Wait for rate gate before fetching — coordinates with repair workers
      await fetcher.waitForRateGate()

      const url = `${gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
      const res = await fetch(url, {
        dispatcher: fetcher.dispatcher,
        signal: abortController.signal,
      } as any)

      if (!res.ok) {
        await res.body?.cancel()
        if (res.status === 429) {
          fetcher.signalRateLimit(res.headers.get('retry-after'))
          continue
        }
        if (res.status >= 500) {
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
      trackingPromise = (async () => {
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

      // Success — verify the backend can traverse the full DAG
      const verifyResult = await backend.verifyDag(rootCid)
      if (verifyResult.valid) {
        queue.markComplete(rootCid, backend.name, byteCount)
        onProgress?.({ type: 'done', rootCid, bytes: byteCount })
        return
      }

      // Repair decisions depend on manifest state, so wait for tracking to finish
      // before falling through to the post-download repair path.
      await trackingPromise

      // Import succeeded but verification failed — mark partial, will repair
      queue.setStatus(rootCid, backend.name, 'partial')
      lastError = new Error(verifyResult.error || 'DAG verification failed after import')
      break

    } catch (err: any) {
      lastError = err
      cleanupStreams?.()
      await trackingPromise?.catch(() => {})
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

    // Generic repair
    {
      const result = await repairUpload(
        rootCid,
        manifest,
        (cidStr) => fetcher.fetchBlock(cidStr),
        {
          onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
          onBlock: backend.putBlock ? async (block) => { await backend.putBlock!(block.cid.toString(), block.bytes, rootCid) } : undefined,
          fetchSubCar: (cid) => fetcher.fetchCar(cid),
        },
      )

      if (result && result.complete) {
        // Merge repair sidecar for local backend
        if ('mergeRepairCar' in backend) {
          await (backend as any).mergeRepairCar(rootCid)
        }

        const verifyResult = await backend.verifyDag(rootCid)
        if (verifyResult.valid) {
          queue.markComplete(rootCid, backend.name, 0)
          onProgress?.({ type: 'done', rootCid, bytes: 0 })
          log('REPAIR', `${tag} Repaired and verified`)
          return
        }

        queue.setStatus(rootCid, backend.name, 'partial')
        lastError = new Error(verifyResult.error || 'DAG verification failed after repair')
      }
    }
  }

  // All attempts failed
  queue.markError(rootCid, backend.name, lastError?.message || 'unknown error')
  onProgress?.({ type: 'error', rootCid, error: lastError?.message })
}

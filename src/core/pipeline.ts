import { Readable, PassThrough } from 'node:stream'
import { CarBlockIterator } from '@ipld/car'
import * as dagPB from '@ipld/dag-pb'
import { GatewayFetcher } from './fetcher.js'
import { repairUpload } from './repair.js'
import type { UploadQueue, UploadStatus } from './queue.js'
import type { BlockManifest } from './manifest.js'
import type { ShardStore } from './shards.js'
import { resolveUploadShards } from './shard-resolver.js'
import type { ExportBackend } from '../backends/interface.js'
import { log } from '../util/log.js'

export interface ShardResolverContext {
  client: any
  indexer: any
  shardStore: ShardStore
  spaceDid: string
}

export interface ExportUploadOptions {
  rootCid: string
  backends: ExportBackend[]
  queue: UploadQueue
  manifest: BlockManifest
  fetcher: GatewayFetcher
  gatewayUrl: string
  shardStore?: ShardStore
  shardResolver?: ShardResolverContext
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
  const { rootCid, backends, queue, manifest, fetcher, gatewayUrl, maxRetries = 3, uploadTimeout = 300000, onProgress } = options
  const tag = `[${rootCid.slice(0, 24)}...]`
  let lastError: Error | undefined

  // Helper: set status on all backends
  function setAllStatus(status: UploadStatus) {
    for (const b of backends) queue.setStatus(rootCid, b.name, status)
  }

  // Helper: push a block to all backends that support putBlock
  async function putBlockAll(block: { cid: { toString(): string }; bytes: Uint8Array }) {
    for (const b of backends) {
      if (b.putBlock) await b.putBlock(block.cid.toString(), block.bytes, rootCid)
    }
  }

  // Helper: verify all backends, mark each independently. Returns true if all valid.
  async function verifyAll(bytes: number): Promise<boolean> {
    let allValid = true
    for (const b of backends) {
      const result = await b.verifyDag(rootCid)
      if (result.valid) {
        queue.markComplete(rootCid, b.name, bytes)
      } else {
        queue.setStatus(rootCid, b.name, 'partial')
        lastError = new Error(result.error || `DAG verification failed in ${b.name}`)
        allValid = false
      }
    }
    if (allValid) {
      onProgress?.({ type: 'done', rootCid, bytes })
    }
    return allValid
  }

  // Helper: merge repair sidecars on backends that support it
  async function mergeRepairAll() {
    for (const b of backends) {
      if ('mergeRepairCar' in b) await (b as any).mergeRepairCar(rootCid)
    }
  }

  const existingProgress = manifest.getProgress(rootCid)
  if (existingProgress.total > 0 && existingProgress.missing > 0) {
    log('INFO', `${tag} Resuming repair: ${existingProgress.seen}/${existingProgress.total} blocks, ${existingProgress.missing} missing`)
    setAllStatus('repairing')
    onProgress?.({ type: 'repairing', rootCid, totalBlocks: existingProgress.missing })

    const result = await repairUpload(
      rootCid,
      manifest,
      (cidStr) => fetcher.fetchBlock(cidStr),
      {
        onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
        onBlock: async (block) => { await putBlockAll(block) },
        fetchSubCar: (cid) => fetcher.fetchCar(cid),
      },
    )

    if (result && result.complete) {
      await mergeRepairAll()
      if (await verifyAll(0)) {
        log('REPAIR', `${tag} Repaired and verified`)
        return
      }
    }

    log('INFO', `${tag} Repair incomplete, trying full CAR download`)
  }

  // Check which backends already have this content
  const needsExport: ExportBackend[] = []
  for (const b of backends) {
    const check = await b.verifyDag(rootCid)
    if (check.valid) {
      queue.markComplete(rootCid, b.name, 0)
      log('INFO', `${tag} Already complete in ${b.name}`)
    } else {
      needsExport.push(b)
    }
  }
  if (needsExport.length === 0) {
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    return
  }

  // Resolve shards inline if we have a resolver context and haven't cached yet
  if (options.shardResolver && options.shardStore && !options.shardStore.hasResolvedShards(rootCid)) {
    try {
      const { client, indexer, shardStore, spaceDid } = options.shardResolver
      const shards = await resolveUploadShards(rootCid, client, indexer)
      if (shards) {
        shardStore.insertShards(rootCid, spaceDid, shards)
      }
    } catch (err: any) {
      log('INFO', `${tag} Shard resolution failed: ${err.message}`)
    }
  }

  // Try shard path first — direct R2 fetch, no gateway
  if (options.shardStore?.hasResolvedShards(rootCid)) {
    const shards = options.shardStore.getShardsForUpload(rootCid)
    log('INFO', `${tag} Fetching ${shards.length} shard(s) from storage`)
    for (const b of needsExport) queue.setStatus(rootCid, b.name, 'downloading')
    onProgress?.({ type: 'downloading', rootCid })

    let totalBytes = 0
    try {
      for (const shard of shards) {
        const res = await fetch(shard.location_url!)
        if (!res.ok) throw new Error(`Shard fetch HTTP ${res.status}: ${shard.shard_cid.slice(0, 20)}...`)
        const carBytes = new Uint8Array(await res.arrayBuffer())
        totalBytes += carBytes.length

        // Parse blocks and push to all backends via putBlock (append-only, no re-read)
        const { CarBlockIterator } = await import('@ipld/car')
        const iterator = await CarBlockIterator.fromIterable(
          (async function* () { yield carBytes })()
        )
        for await (const block of iterator) {
          manifest.markSeen(rootCid, block.cid.toString(), block.cid.code)
          await putBlockAll(block)
        }
        onProgress?.({ type: 'progress', rootCid, bytes: totalBytes })
        log('INFO', `${tag} Shard ${shard.shard_order + 1}/${shards.length} done (${carBytes.length} bytes)`)
      }

      // Finalize: merge sidecar into final CAR (local), pin root (kubo)
      await mergeRepairAll()
      for (const b of needsExport) {
        if (b.pinRoot) await b.pinRoot(rootCid)
      }

      if (await verifyAll(totalBytes)) {
        log('INFO', `${tag} Complete via shards`)
        return
      }
      log('INFO', `${tag} Shard import incomplete, falling back to gateway`)
    } catch (err: any) {
      log('INFO', `${tag} Shard path failed: ${err.message}, falling back to gateway`)
    }
  }

  for (const b of needsExport) queue.setStatus(rootCid, b.name, 'downloading')

  // Attempt to download the full CAR — stream raw bytes to all backends
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const abortController = new AbortController()
    let cleanupStreams: (() => void) | undefined
    let trackingPromise: Promise<void> | undefined

    try {
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

      // Fork to N backend streams + 1 tracking stream
      const backendStreams = needsExport.map(() => new PassThrough())
      const trackingStream = new PassThrough({ highWaterMark: 1024 * 1024 })

      nodeStream.on('error', (err) => countingStream.destroy(err))
      for (const bs of backendStreams) bs.on('error', () => {})
      trackingStream.on('error', () => {})
      countingStream.on('error', () => {
        for (const bs of backendStreams) bs.destroy()
        trackingStream.destroy()
      })

      nodeStream.pipe(countingStream)
      for (const bs of backendStreams) countingStream.pipe(bs)
      countingStream.pipe(trackingStream)

      cleanupStreams = () => {
        abortController.abort()
        nodeStream.destroy()
        countingStream.destroy()
        for (const bs of backendStreams) bs.destroy()
        trackingStream.destroy()
      }

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
          countingStream.unpipe(trackingStream)
          trackingStream.destroy()
        }
      })()

      // Import to all backends in parallel
      await withTimeout(
        Promise.all(needsExport.map((b, i) => b.importCar(rootCid, backendStreams[i] as any))),
        uploadTimeout,
        `CAR download ${rootCid.slice(0, 24)}...`,
      )

      trackingPromise.catch(() => {})

      if (await verifyAll(byteCount)) return

      // Wait for tracking before falling through to repair
      await trackingPromise
      break

    } catch (err: any) {
      lastError = err
      cleanupStreams?.()
      await trackingPromise?.catch(() => {})
      if (attempt < maxRetries) {
        manifest.resetSeen(rootCid)
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid, attempt, delay, error: err.message })
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  // Download failed — check if we got partial data
  const progress = manifest.getProgress(rootCid)
  if (progress.total > 0) {
    for (const b of needsExport) queue.setStatus(rootCid, b.name, 'partial')
    const missingPB = manifest.getMissingDagPB(rootCid).length
    log('INFO', `${tag} Partial: ${progress.seen}/${progress.total} blocks (${progress.missing} missing, ${missingPB} dag-pb)`)
  }

  // Attempt inline repair
  if (progress.total > 0 && progress.missing > 0) {
    setAllStatus('repairing')
    onProgress?.({ type: 'repairing', rootCid, totalBlocks: progress.missing })

    const result = await repairUpload(
      rootCid,
      manifest,
      (cidStr) => fetcher.fetchBlock(cidStr),
      {
        onProgress: (fetched, total, bytes) => onProgress?.({ type: 'repair-progress', rootCid, fetched, total, bytes }),
        onBlock: async (block) => { await putBlockAll(block) },
        fetchSubCar: (cid) => fetcher.fetchCar(cid),
      },
    )

    if (result && result.complete) {
      await mergeRepairAll()
      if (await verifyAll(0)) {
        log('REPAIR', `${tag} Repaired and verified`)
        return
      }
    }
  }

  // All attempts failed — mark error on backends that aren't complete
  for (const b of needsExport) {
    queue.markError(rootCid, b.name, lastError?.message || 'unknown error')
  }
  onProgress?.({ type: 'error', rootCid, error: lastError?.message })
}

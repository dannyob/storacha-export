import { Readable } from 'node:stream'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Agent } from 'undici'
import { log } from './progress.js'
import { repairTruncatedCar } from './repair.js'

const DEFAULT_GATEWAY = 'https://w3s.link'

// 10 minute body timeout — long enough for stalls to recover,
// short enough not to waste hours on a truly dead connection.
const fetchDispatcher = new Agent({
  bodyTimeout: 600000,   // 10 min between chunks before retry
  headersTimeout: 60000, // 60s to get initial response headers
})

export function buildGatewayUrl(rootCid, gatewayUrl = DEFAULT_GATEWAY) {
  return `${gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
}

/**
 * Execute a single export job: fetch CAR from gateway, stream to backends.
 *
 * @param {{ root_cid: string, backend: string }} job
 * @param {import('./backends/index.js').ExportBackend[]} backends
 * @param {import('./queue.js').JobQueue} queue
 * @param {object} [options]
 * @param {string} [options.gatewayUrl]
 * @param {(info: object) => void} [options.onProgress]
 * @param {number} [options.maxRetries]
 */
export async function executeJob(job, backends, queue, options = {}) {
  const { gatewayUrl, onProgress, maxRetries = 3 } = options
  const url = buildGatewayUrl(job.root_cid, gatewayUrl)

  queue.markInProgress(job.root_cid, job.backend)

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, { dispatcher: fetchDispatcher })
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel()
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid: job.root_cid, spaceName: job.space_name, attempt, delay, error: `HTTP ${res.status}` })
        await sleep(delay)
        continue
      }
      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`Gateway returned ${res.status}: ${res.statusText}`)
      }

      const nodeStream = Readable.fromWeb(res.body)

      // Count bytes and log progress periodically for large downloads
      let byteCount = 0
      let lastProgressLog = Date.now()
      const countingStream = new PassThrough({
        transform(chunk, encoding, callback) {
          byteCount += chunk.length
          const now = Date.now()
          if (now - lastProgressLog > 30000) { // every 30s
            onProgress?.({ type: 'downloading', rootCid: job.root_cid, spaceName: job.space_name, bytes: byteCount })
            lastProgressLog = now
          }
          callback(null, chunk)
        }
      })

      // Handle stream errors (e.g. body timeout) to prevent unhandled crash
      nodeStream.on('error', (err) => countingStream.destroy(err))
      nodeStream.pipe(countingStream)

      if (backends.length === 1) {
        await backends[0].importCar(job.root_cid, countingStream)
      } else {
        const streams = backends.map(() => new PassThrough())
        countingStream.on('data', chunk => {
          for (const s of streams) s.write(chunk)
        })
        countingStream.on('end', () => {
          for (const s of streams) s.end()
        })
        countingStream.on('error', err => {
          for (const s of streams) s.destroy(err)
        })

        await Promise.all(
          backends.map((be, i) => be.importCar(job.root_cid, streams[i]))
        )
      }

      queue.markDone(job.root_cid, job.backend, byteCount)
      onProgress?.({ type: 'done', rootCid: job.root_cid, spaceName: job.space_name, bytes: byteCount })
      return

    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid: job.root_cid, spaceName: job.space_name, attempt, delay, error: err.message })
        await sleep(delay)
      }
    }
  }

  // If the error looks like a truncated CAR, try repair
  if (lastError?.message?.includes('unexpected EOF') || lastError?.message?.includes('import failed')) {
    try {
      const repair = await repairTruncatedCar(
        job.root_cid,
        gatewayUrl || DEFAULT_GATEWAY,
        onProgress
      )
      if (repair) {
        // Import the repair CAR (missing blocks only)
        for (const be of backends) {
          await be.importCar(job.root_cid, repair.stream)
        }
        if (repair.complete) {
          // Verify the root is actually pinned (complete DAG)
          let verified = false
          for (const be of backends) {
            if (await be.hasContent(job.root_cid)) {
              verified = true
            } else {
              log('REPAIR', `[${job.space_name}] ${job.root_cid.slice(0, 24)}... repair imported but root not pinned in ${be.name} — DAG may still be incomplete`)
              verified = false
              break
            }
          }
          if (verified) {
            queue.markDone(job.root_cid, job.backend, 0)
            onProgress?.({ type: 'done', rootCid: job.root_cid, spaceName: job.space_name, bytes: 0 })
            log('REPAIR', `[${job.space_name}] ${job.root_cid.slice(0, 24)}... repaired and verified`)
            return
          }
        }
      }
    } catch (repairErr) {
      log('REPAIR', `[${job.space_name}] ${job.root_cid.slice(0, 24)}... repair failed: ${repairErr.message}`)
    }
  }

  queue.markError(job.root_cid, job.backend, lastError?.message || 'unknown error')
  onProgress?.({ type: 'error', rootCid: job.root_cid, spaceName: job.space_name, error: lastError?.message })
}

/**
 * Run all pending jobs with concurrency control.
 *
 * @param {import('./queue.js').JobQueue} queue
 * @param {import('./backends/index.js').ExportBackend[]} backends
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {string} [options.gatewayUrl]
 * @param {(job: object) => boolean} [options.spaceFilter]
 * @param {(info: object) => void} [options.onProgress]
 */
export async function executeAll(queue, backends, options = {}) {
  const { concurrency = 1, gatewayUrl, spaceFilter, onProgress } = options
  const backendNames = backends.map(b => b.name)

  // Collect all pending jobs across backends, filtered by selected spaces
  const allPending = []
  for (const name of backendNames) {
    let pending = queue.getPending(name)
    if (spaceFilter) {
      const before = pending.length
      pending = pending.filter(spaceFilter)
      if (pending.length !== before) {
        log('INFO', `${pending.length} pending jobs for ${name} (${before - pending.length} filtered by space selection)`)
      }
    }
    allPending.push(...pending)
  }

  log('INFO', `${allPending.length} jobs to process`)

  if (allPending.length === 0) {
    onProgress?.({ type: 'complete', total: 0 })
    return
  }

  // Simple concurrency pool
  let idx = 0
  const total = allPending.length

  async function worker() {
    while (idx < allPending.length) {
      const job = allPending[idx++]
      await executeJob(job, backends, queue, { gatewayUrl, onProgress })
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  onProgress?.({ type: 'complete', total })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

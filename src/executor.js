import { Readable } from 'node:stream'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_GATEWAY = 'https://w3s.link'

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
      const res = await fetch(url)
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid: job.root_cid, attempt, delay })
        await sleep(delay)
        continue
      }
      if (!res.ok) {
        throw new Error(`Gateway returned ${res.status}: ${res.statusText}`)
      }

      const nodeStream = Readable.fromWeb(res.body)

      if (backends.length === 1) {
        // Direct pipe — no tee overhead
        await backends[0].importCar(job.root_cid, nodeStream)
      } else {
        // Tee to multiple backends
        const streams = backends.map(() => new PassThrough())
        nodeStream.on('data', chunk => {
          for (const s of streams) s.write(chunk)
        })
        nodeStream.on('end', () => {
          for (const s of streams) s.end()
        })
        nodeStream.on('error', err => {
          for (const s of streams) s.destroy(err)
        })

        await Promise.all(
          backends.map((be, i) => be.importCar(job.root_cid, streams[i]))
        )
      }

      // Count bytes (approximate — from content-length if available)
      const bytes = parseInt(res.headers.get('content-length') || '0', 10)
      queue.markDone(job.root_cid, job.backend, bytes)
      onProgress?.({ type: 'done', rootCid: job.root_cid, bytes })
      return

    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid: job.root_cid, attempt, delay })
        await sleep(delay)
      }
    }
  }

  queue.markError(job.root_cid, job.backend, lastError?.message || 'unknown error')
  onProgress?.({ type: 'error', rootCid: job.root_cid, error: lastError?.message })
}

/**
 * Run all pending jobs with concurrency control.
 *
 * @param {import('./queue.js').JobQueue} queue
 * @param {import('./backends/index.js').ExportBackend[]} backends
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {string} [options.gatewayUrl]
 * @param {(info: object) => void} [options.onProgress]
 */
export async function executeAll(queue, backends, options = {}) {
  const { concurrency = 1, gatewayUrl, onProgress } = options
  const backendNames = backends.map(b => b.name)

  // Collect all pending jobs across backends
  const allPending = []
  for (const name of backendNames) {
    const pending = queue.getPending(name)
    allPending.push(...pending)
  }

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

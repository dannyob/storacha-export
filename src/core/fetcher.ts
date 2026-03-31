import { Agent } from 'undici'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { carToBlockStream } from './blocks.js'
import type { BlockStream, Block } from './blocks.js'
import { log } from '../util/log.js'

const carDispatcher = new Agent({
  bodyTimeout: 120000,   // 2 min between chunks — fail fast on stalls
  headersTimeout: 60000, // 60s for initial response
})

const blockDispatcher = new Agent({
  bodyTimeout: 30000,    // 30s — individual blocks should be fast
  headersTimeout: 30000, // 30s for initial response
  connections: 10,       // separate pool from CAR downloads
})

/**
 * Shared gate that pauses ALL fetches (blocks AND CARs) when the gateway says 429.
 * Only logs once per backoff period.
 */
class RateLimitGate {
  private _resumeAt = 0
  private _waiters: Array<() => void> = []
  private _timer: ReturnType<typeof setTimeout> | null = null

  /** Called when a 429 is received. All waiters will pause. */
  backoff(seconds: number) {
    const resumeAt = Date.now() + seconds * 1000
    if (resumeAt <= this._resumeAt) return // already waiting longer — don't log again

    const wasBlocked = this._resumeAt > Date.now()
    this._resumeAt = resumeAt

    if (!wasBlocked) {
      // Only log on the first 429 in a burst
      log('INFO', `Rate limited — all fetches paused for ${seconds}s`)
    }

    // Reset or set the timer
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._resumeAt = 0
      this._timer = null
      log('INFO', `Rate limit cleared — resuming fetches`)
      // Wake all waiters
      const waiters = this._waiters.splice(0)
      for (const resolve of waiters) resolve()
    }, seconds * 1000)
  }

  /** Wait if currently rate-limited. Returns immediately if not. */
  async wait(): Promise<void> {
    if (Date.now() < this._resumeAt) {
      await new Promise<void>(resolve => this._waiters.push(resolve))
    }
  }

  get isBlocked(): boolean {
    return Date.now() < this._resumeAt
  }
}

export class GatewayFetcher {
  readonly dispatcher = carDispatcher
  private rateGate = new RateLimitGate()
  constructor(private gatewayUrl: string) {}

  /**
   * Fetch a CAR for a root CID and return it as a BlockStream.
   * Respects rate limiting.
   */
  async fetchCar(rootCid: string): Promise<BlockStream> {
    await this.rateGate.wait()

    const url = `${this.gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
    const res = await fetch(url, { dispatcher: carDispatcher } as any)

    if (res.status === 429) {
      const retryAfter = res.headers.get('retry-after')
      const seconds = retryAfter ? parseInt(retryAfter, 10) : 60
      await res.body?.cancel()
      this.rateGate.backoff(seconds)
      throw new Error(`Gateway returned 429: Too Many Requests`)
    }

    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`Gateway returned ${res.status}: ${res.statusText}`)
    }

    return carToBlockStream(res.body!)
  }

  /**
   * Fetch a single block by CID.
   * Returns the block with verified hash, or throws.
   */
  async fetchBlock(cidStr: string): Promise<Block> {
    const url = `${this.gatewayUrl.replace(/\/$/, '')}/ipfs/${cidStr}?format=raw`

    for (let attempt = 0; attempt < 3; attempt++) {
      // Wait if the gateway has told us to back off
      await this.rateGate.wait()

      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined

      try {
        const res = await Promise.race([
          fetch(url, { dispatcher: blockDispatcher, signal: controller.signal } as any),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('Block fetch timeout (30s)')) }, 30000)
          }),
        ])

        if (timer) { clearTimeout(timer); timer = undefined }

        if (res.status === 429) {
          const retryAfter = res.headers.get('retry-after')
          const seconds = retryAfter ? parseInt(retryAfter, 10) : 60
          await res.body?.cancel()
          this.rateGate.backoff(seconds + Math.floor(Math.random() * 5))
          continue
        }

        if (res.status >= 500) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 30000)
          await res.body?.cancel()
          log('RETRY', `Block ${cidStr.slice(0, 20)}... HTTP ${res.status}, waiting ${Math.round(delay / 1000)}s`)
          await new Promise(r => setTimeout(r, delay))
          continue
        }

        if (!res.ok) {
          throw new Error(`Block fetch failed: HTTP ${res.status}`)
        }

        const bytes = new Uint8Array(await res.arrayBuffer())
        const expectedCid = CID.parse(cidStr)
        const hash = await sha256.digest(bytes)

        if (!expectedCid.multihash.bytes.every((b, i) => b === hash.bytes[i])) {
          throw new Error(`Hash mismatch for ${cidStr}`)
        }

        return { cid: expectedCid, bytes }
      } catch (err: any) {
        if (attempt === 2) throw err
        if (!err.message.includes('timeout')) throw err
        // Timeout — retry
      } finally {
        if (timer) clearTimeout(timer)
      }
    }
    throw new Error('Block fetch failed after retries')
  }

  /**
   * Fetch multiple blocks as a BlockStream, skipping those that fail.
   */
  async *fetchBlocks(cidStrs: string[], onProgress?: (fetched: number, total: number) => void): BlockStream {
    let fetched = 0
    for (const cidStr of cidStrs) {
      try {
        const block = await this.fetchBlock(cidStr)
        fetched++
        onProgress?.(fetched, cidStrs.length)
        yield block
      } catch (err: any) {
        log('REPAIR', `  FAIL ${cidStr.slice(0, 24)}...: ${err.message}`)
      }
    }
  }
}

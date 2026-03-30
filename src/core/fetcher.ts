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

export class GatewayFetcher {
  readonly dispatcher = carDispatcher
  constructor(private gatewayUrl: string) {}

  /**
   * Fetch a CAR for a root CID and return it as a BlockStream.
   */
  async fetchCar(rootCid: string): Promise<BlockStream> {
    const url = `${this.gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
    const res = await fetch(url, { dispatcher: carDispatcher } as any)

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
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30000)

    try {
      const res = await fetch(url, { dispatcher: blockDispatcher, signal: controller.signal } as any)

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
    } finally {
      clearTimeout(timeout)
    }
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

import { Agent } from 'undici'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { carToBlockStream } from './blocks.js'
import type { BlockStream, Block } from './blocks.js'
import { log } from '../util/log.js'

const fetchDispatcher = new Agent({
  bodyTimeout: 600000,   // 10 min between chunks
  headersTimeout: 60000, // 60s for initial response
})

export class GatewayFetcher {
  constructor(private gatewayUrl: string) {}

  /**
   * Fetch a CAR for a root CID and return it as a BlockStream.
   */
  async fetchCar(rootCid: string): Promise<BlockStream> {
    const url = `${this.gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
    const res = await fetch(url, { dispatcher: fetchDispatcher } as any)

    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`Gateway returned ${res.status}: ${res.statusText}`)
    }

    return carToBlockStream(res.body!)
  }

  /**
   * Fetch a single raw block by CID.
   * Returns the block with verified CID, or throws.
   */
  async fetchBlock(cidStr: string): Promise<Block> {
    const url = `https://${cidStr}.ipfs.w3s.link/?format=raw`
    const res = await fetch(url, { dispatcher: fetchDispatcher } as any)

    if (!res.ok) {
      throw new Error(`Block fetch failed: HTTP ${res.status}`)
    }

    const bytes = new Uint8Array(await res.arrayBuffer())
    const hash = await sha256.digest(bytes)
    const cid = CID.create(1, 0x55, hash)

    if (cid.toString() !== cidStr) {
      throw new Error(`CID mismatch: expected ${cidStr}, got ${cid.toString()}`)
    }

    return { cid, bytes }
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

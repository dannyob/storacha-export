import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exportUpload } from '../../src/core/pipeline.js'
import { UploadQueue } from '../../src/core/queue.js'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from './blocks.test.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { CarBlockIterator } from '@ipld/car'
import type { ExportBackend } from '../../src/backends/interface.js'
import { GatewayFetcher } from '../../src/core/fetcher.js'
import { ShardStore } from '../../src/core/shards.js'

const TEST_DB = '/tmp/storacha-v2-pipeline-test.db'

/** Simple in-memory backend for testing — accepts raw CAR byte streams */
class MemoryBackend implements ExportBackend {
  name = 'memory'
  blocks = new Map<string, Uint8Array>()
  pinned = new Set<string>()

  async importCar(rootCid: string, stream: any): Promise<void> {
    // Collect raw bytes from the stream
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk)
    const carBytes = Buffer.concat(chunks)

    // Parse CAR to extract blocks
    const iterator = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(carBytes) })()
    )
    for await (const { cid, bytes } of iterator) {
      this.blocks.set(cid.toString(), bytes)
    }
    this.pinned.add(rootCid)
  }

  async hasContent(rootCid: string): Promise<boolean> {
    return this.pinned.has(rootCid)
  }

  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    return this.pinned.has(rootCid)
      ? { valid: true }
      : { valid: false, error: 'not pinned' }
  }

  async hasBlock(cid: string): Promise<boolean> {
    return this.blocks.has(cid)
  }

  async putBlock(cid: string, bytes: Uint8Array): Promise<void> {
    this.blocks.set(cid, bytes)
  }
}

describe('exportUpload', () => {
  let db: Database.Database
  let queue: UploadQueue
  let manifest: BlockManifest

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    queue = new UploadQueue(db)
    manifest = new BlockManifest(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('exports a complete CAR successfully', async () => {
    const leaf1 = await makeRawBlock('hello')
    const leaf2 = await makeRawBlock('world')
    const root = await makeDagPBNode([leaf1, leaf2])
    const carBytes = await buildCarBytes([root, leaf1, leaf2], [root])
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(carBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
    })) as any
    const gatewayUrl = 'http://gateway.test'
    const fetcher = new GatewayFetcher(gatewayUrl)

    const backend = new MemoryBackend()
    queue.add({ rootCid: root.cid.toString(), spaceDid: 'did:key:test', spaceName: 'Test', backend: 'memory' })

    try {
      await exportUpload({
        rootCid: root.cid.toString(),
        backends: [backend],
        queue,
        manifest,
        fetcher,
        gatewayUrl,
      })

      expect(queue.getStatus(root.cid.toString(), 'memory')).toBe('complete')
      expect(backend.pinned.has(root.cid.toString())).toBe(true)
      expect(backend.blocks.size).toBe(3)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not trust hasContent alone when deciding completion', async () => {
    const leaf = await makeRawBlock('hello')
    const root = await makeDagPBNode([leaf])
    const carBytes = await buildCarBytes([root, leaf], [root])
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(carBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
    })) as any
    const gatewayUrl = 'http://gateway.test'
    const fetcher = new GatewayFetcher(gatewayUrl)

    const backend: ExportBackend = {
      name: 'lying',
      imported: false,
      async importCar(_rootCid: string, stream: any): Promise<void> {
        for await (const _chunk of stream) {}
        this.imported = true
      },
      async hasContent(): Promise<boolean> {
        return true
      },
      async verifyDag(): Promise<{ valid: boolean; error?: string }> {
        return this.imported
          ? { valid: true }
          : { valid: false, error: 'file exists but DAG is incomplete' }
      },
    } as any

    queue.add({ rootCid: root.cid.toString(), spaceDid: 'did:key:test', spaceName: 'Test', backend: 'lying' })

    try {
      await exportUpload({
        rootCid: root.cid.toString(),
        backends: [backend],
        queue,
        manifest,
        fetcher,
        gatewayUrl,
      })

      expect((backend as any).imported).toBe(true)
      expect(queue.getStatus(root.cid.toString(), 'lying')).toBe('complete')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('skips download when verifyDag already confirms completeness', async () => {
    const rootCid = 'bafyalreadycomplete'
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      throw new Error('fetch should not be called')
    }) as any

    let importCalls = 0
    const backend: ExportBackend = {
      name: 'ready',
      async importCar() {
        importCalls++
      },
      async verifyDag() {
        return { valid: true }
      },
    }

    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'ready' })

    try {
      await exportUpload({
        rootCid,
        backends: [backend],
        queue,
        manifest,
        fetcher: new GatewayFetcher('http://gateway.test'),
        gatewayUrl: 'http://gateway.test',
      })

      expect(importCalls).toBe(0)
      expect(globalThis.fetch).not.toHaveBeenCalled()
      expect(queue.getStatus(rootCid, 'ready')).toBe('complete')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('waits for tracking to finish before deciding whether repair can run', async () => {
    const leaf = await makeRawBlock('needs-repair')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()
    const truncatedCar = await buildCarBytes([root], [root])

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === `/ipfs/${rootCid}` && url.searchParams.get('format') === 'car') {
        return new Response(truncatedCar, {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.ipld.car' },
        })
      }
      if (url.pathname === `/ipfs/${leaf.cid.toString()}` && url.searchParams.get('format') === 'raw') {
        return new Response(leaf.bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const originalFromIterable = CarBlockIterator.fromIterable
    const fromIterableSpy = vi.spyOn(CarBlockIterator, 'fromIterable').mockImplementation(async (iterable: any) => {
      const iterator = await originalFromIterable(iterable)
      return (async function* () {
        for await (const block of iterator) {
          await new Promise(resolve => setTimeout(resolve, 25))
          yield block
        }
      })()
    })

    let repaired = false
    const backend: ExportBackend = {
      name: 'repairable',
      async importCar(_rootCid: string, stream: any): Promise<void> {
        for await (const _chunk of stream) {}
      },
      async verifyDag(): Promise<{ valid: boolean; error?: string }> {
        return repaired
          ? { valid: true }
          : { valid: false, error: 'missing repaired block' }
      },
      async putBlock(cid: string): Promise<void> {
        if (cid === leaf.cid.toString()) repaired = true
      },
    }

    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'repairable' })

    try {
      await exportUpload({
        rootCid,
        backends: [backend],
        queue,
        manifest,
        fetcher: new GatewayFetcher('http://gateway.test'),
        gatewayUrl: 'http://gateway.test',
      })

      expect(repaired).toBe(true)
      expect(queue.getStatus(rootCid, 'repairable')).toBe('complete')
    } finally {
      fromIterableSpy.mockRestore()
      globalThis.fetch = originalFetch
    }
  })

  it('waits for tracking to finish before resetting seen flags for a retry', async () => {
    const leaf = await makeRawBlock('retry-leaf')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()
    const truncatedCar = await buildCarBytes([root], [root])

    const originalFetch = globalThis.fetch
    vi.useFakeTimers()

    let attempt = 0
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname === `/ipfs/${rootCid}` && url.searchParams.get('format') === 'car') {
        attempt++
        if (attempt === 1) {
          return new Response(truncatedCar, {
            status: 200,
            headers: { 'Content-Type': 'application/vnd.ipld.car' },
          })
        }
        return new Response('not found', { status: 404 })
      }
      if (url.pathname === `/ipfs/${rootCid}` && url.searchParams.get('format') === 'raw') {
        return new Response(root.bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      if (url.pathname === `/ipfs/${leaf.cid.toString()}` && url.searchParams.get('format') === 'raw') {
        return new Response(leaf.bytes, {
          status: 200,
          headers: { 'Content-Type': 'application/octet-stream' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const fromIterableSpy = vi.spyOn(CarBlockIterator, 'fromIterable').mockImplementation(async () => {
      return (async function* () {
        await new Promise(resolve => setTimeout(resolve, 25))
        yield { cid: root.cid, bytes: root.bytes }
      })() as any
    })

    let importCalls = 0
    const repairedCids = new Set<string>()
    const repairingTotals: number[] = []
    const backend: ExportBackend = {
      name: 'flaky',
      async importCar(_rootCid: string, stream: any): Promise<void> {
        importCalls++
        for await (const _chunk of stream) {}
        if (importCalls === 1) throw new Error('fail first attempt')
      },
      async verifyDag(): Promise<{ valid: boolean; error?: string }> {
        return repairedCids.has(rootCid) && repairedCids.has(leaf.cid.toString())
          ? { valid: true }
          : { valid: false, error: 'missing blocks' }
      },
      async putBlock(cid: string): Promise<void> {
        repairedCids.add(cid)
      },
    }

    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'flaky' })

    try {
      const exportPromise = exportUpload({
        rootCid,
        backends: [backend],
        queue,
        manifest,
        fetcher: new GatewayFetcher('http://gateway.test'),
        gatewayUrl: 'http://gateway.test',
        maxRetries: 2,
        onProgress: (info) => {
          if (info.type === 'repairing') repairingTotals.push(info.totalBlocks)
        },
      })

      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(25)
      await vi.advanceTimersByTimeAsync(5000)
      await exportPromise

      expect(importCalls).toBe(1)
      expect(repairingTotals[0]).toBe(2)
      expect(queue.getStatus(rootCid, 'flaky')).toBe('complete')
      expect(repairedCids.has(rootCid)).toBe(true)
      expect(repairedCids.has(leaf.cid.toString())).toBe(true)
    } finally {
      fromIterableSpy.mockRestore()
      globalThis.fetch = originalFetch
      vi.useRealTimers()
    }
  })

  it('streams blocks to multiple backends simultaneously', async () => {
    const leaf1 = await makeRawBlock('multi-a')
    const leaf2 = await makeRawBlock('multi-b')
    const root = await makeDagPBNode([leaf1, leaf2])
    const carBytes = await buildCarBytes([root, leaf1, leaf2], [root])
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(carBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
    })) as any

    const backend1 = new MemoryBackend()
    backend1.name = 'mem1'
    const backend2 = new MemoryBackend()
    backend2.name = 'mem2'

    const rootCid = root.cid.toString()
    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'mem1' })
    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'mem2' })

    try {
      await exportUpload({
        rootCid,
        backends: [backend1, backend2],
        queue,
        manifest,
        fetcher: new GatewayFetcher('http://gateway.test'),
        gatewayUrl: 'http://gateway.test',
      })

      expect(queue.getStatus(rootCid, 'mem1')).toBe('complete')
      expect(queue.getStatus(rootCid, 'mem2')).toBe('complete')
      expect(backend1.blocks.size).toBe(3)
      expect(backend2.blocks.size).toBe(3)
      // Only one fetch call — data streamed to both from single download
      expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('skips backends that already have content', async () => {
    const leaf = await makeRawBlock('skip-test')
    const root = await makeDagPBNode([leaf])
    const carBytes = await buildCarBytes([root, leaf], [root])
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(carBytes, {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
    })) as any

    const backend1 = new MemoryBackend()
    backend1.name = 'has-it'
    backend1.pinned.add(root.cid.toString())

    const backend2 = new MemoryBackend()
    backend2.name = 'needs-it'

    const rootCid = root.cid.toString()
    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'has-it' })
    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'needs-it' })

    try {
      await exportUpload({
        rootCid,
        backends: [backend1, backend2],
        queue,
        manifest,
        fetcher: new GatewayFetcher('http://gateway.test'),
        gatewayUrl: 'http://gateway.test',
      })

      expect(queue.getStatus(rootCid, 'has-it')).toBe('complete')
      expect(queue.getStatus(rootCid, 'needs-it')).toBe('complete')
      // backend1 already had it, only backend2 needed the import
      expect(backend1.blocks.size).toBe(0)
      expect(backend2.blocks.size).toBe(2)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('uses shard path when shards are resolved', async () => {
    const leaf1 = await makeRawBlock('shard-leaf-a')
    const leaf2 = await makeRawBlock('shard-leaf-b')
    const root = await makeDagPBNode([leaf1, leaf2])
    const rootCid = root.cid.toString()

    // Build two "shard" CARs
    const car1 = await buildCarBytes([root, leaf1], [root])
    const car2 = await buildCarBytes([leaf2], [leaf2])

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === 'https://r2.example/shard-0') {
        return new Response(car1, { status: 200 })
      }
      if (url === 'https://r2.example/shard-1') {
        return new Response(car2, { status: 200 })
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as any

    const backend = new MemoryBackend()
    queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'Test', backend: 'memory' })

    const shardStore = new ShardStore(db)
    shardStore.insertShards(rootCid, 'did:key:test', [
      { shardCid: 'bafyshard0', locationUrl: 'https://r2.example/shard-0', size: car1.byteLength, order: 0 },
      { shardCid: 'bafyshard1', locationUrl: 'https://r2.example/shard-1', size: car2.byteLength, order: 1 },
    ])

    try {
      await exportUpload({
        rootCid,
        backends: [backend],
        queue,
        manifest,
        fetcher: new GatewayFetcher('http://gateway.test'),
        gatewayUrl: 'http://gateway.test',
        shardStore,
      })

      expect(queue.getStatus(rootCid, 'memory')).toBe('complete')
      expect(backend.blocks.size).toBe(3)
      // Should NOT have called the gateway — only R2 URLs
      const calls = (globalThis.fetch as any).mock.calls.map((c: any) => String(c[0]))
      expect(calls.every((u: string) => u.startsWith('https://r2.example/'))).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

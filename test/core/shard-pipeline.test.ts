import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exportUploadViaShards } from '../../src/core/shard-pipeline.js'
import { UploadQueue } from '../../src/core/queue.js'
import { ShardStore } from '../../src/core/shards.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from './blocks.test.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { ExportBackend } from '../../src/backends/interface.js'
import { GatewayFetcher } from '../../src/core/fetcher.js'

const TEST_DB = '/tmp/storacha-v2-shard-pipeline-test.db'

/** Backend that collects blocks from a BlockStream (not raw bytes) */
class BlockCollectorBackend implements ExportBackend {
  name = 'collector'
  blocks = new Map<string, Uint8Array>()
  rootCids = new Set<string>()

  async importCar(rootCid: string, stream: any): Promise<void> {
    this.rootCids.add(rootCid)
    for await (const block of stream) {
      if (block.cid) {
        this.blocks.set(block.cid.toString(), block.bytes)
      }
    }
  }

  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    return this.rootCids.has(rootCid) && this.blocks.size > 0
      ? { valid: true }
      : { valid: false, error: 'not imported' }
  }
}

describe('exportUploadViaShards', () => {
  let db: Database.Database
  let queue: UploadQueue
  let shardStore: ShardStore

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    queue = new UploadQueue(db)
    shardStore = new ShardStore(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('fetches shards in order and passes combined block stream to backend', async () => {
    const leaf1 = await makeRawBlock('leaf-one')
    const leaf2 = await makeRawBlock('leaf-two')
    const root = await makeDagPBNode([leaf1, leaf2])
    const rootCid = root.cid.toString()

    const shard1Car = await buildCarBytes([root, leaf1], [root])
    const shard2Car = await buildCarBytes([leaf2], [])

    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard1', shardSize: shard1Car.length, shardOrder: 0, spaceDid: 'did:key:z' })
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard2', shardSize: shard2Car.length, shardOrder: 1, spaceDid: 'did:key:z' })

    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'Test', backend: 'collector' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('bafyshard1')) {
        return new Response(shard1Car, { status: 200 })
      }
      if (url.pathname.includes('bafyshard2')) {
        return new Response(shard2Car, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const backend = new BlockCollectorBackend()
    const fetcher = new GatewayFetcher('http://gateway.test')

    try {
      await exportUploadViaShards({
        rootCid,
        backend,
        queue,
        shardStore,
        fetcher,
      })

      expect(queue.getStatus(rootCid, 'collector')).toBe('complete')
      expect(backend.blocks.size).toBe(3)
      expect(backend.blocks.has(root.cid.toString())).toBe(true)
      expect(backend.blocks.has(leaf1.cid.toString())).toBe(true)
      expect(backend.blocks.has(leaf2.cid.toString())).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks upload as error when verification fails', async () => {
    const leaf = await makeRawBlock('only-leaf')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()
    const shardCar = await buildCarBytes([leaf], [])

    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard', shardSize: shardCar.length, shardOrder: 0, spaceDid: 'did:key:z' })
    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'Test', backend: 'failverify' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(shardCar, { status: 200 })) as any

    const backend: ExportBackend = {
      name: 'failverify',
      async importCar(_rootCid: string, stream: any) { for await (const _ of stream) {} },
      async verifyDag() { return { valid: false, error: 'root missing' } },
    }

    try {
      await exportUploadViaShards({
        rootCid,
        backend,
        queue,
        shardStore,
        fetcher: new GatewayFetcher('http://gateway.test'),
      })

      expect(queue.getStatus(rootCid, 'failverify')).toBe('error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('skips download when verifyDag already confirms completeness', async () => {
    const rootCid = 'bafyalreadydone'
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard', shardSize: 100, shardOrder: 0, spaceDid: 'did:key:z' })
    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'Test', backend: 'done' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('should not fetch') }) as any

    const backend: ExportBackend = {
      name: 'done',
      async importCar() { throw new Error('should not import') },
      async verifyDag() { return { valid: true } },
    }

    try {
      await exportUploadViaShards({
        rootCid,
        backend,
        queue,
        shardStore,
        fetcher: new GatewayFetcher('http://gateway.test'),
      })

      expect(queue.getStatus(rootCid, 'done')).toBe('complete')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

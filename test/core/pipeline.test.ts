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

    const backend = new MemoryBackend()
    queue.add({ rootCid: root.cid.toString(), spaceDid: 'did:key:test', spaceName: 'Test', backend: 'memory' })

    try {
      await exportUpload({
        rootCid: root.cid.toString(),
        backend,
        queue,
        manifest,
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
        backend,
        queue,
        manifest,
        gatewayUrl,
      })

      expect((backend as any).imported).toBe(true)
      expect(queue.getStatus(root.cid.toString(), 'lying')).toBe('complete')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

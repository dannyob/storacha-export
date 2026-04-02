import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runExport } from '../../src/phases/export.js'
import { UploadQueue } from '../../src/core/queue.js'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from '../core/blocks.test.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { CarBlockIterator } from '@ipld/car'
import type { ExportBackend } from '../../src/backends/interface.js'

const TEST_DB = '/tmp/storacha-v2-export-phase-test.db'

class MemoryBackend implements ExportBackend {
  name = 'memory'
  blocks = new Map<string, Uint8Array>()
  pinned = new Set<string>()
  async importCar(rootCid: string, stream: any) {
    const chunks: Uint8Array[] = []
    for await (const chunk of stream) chunks.push(chunk)
    const iterator = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(Buffer.concat(chunks)) })()
    )
    for await (const { cid, bytes } of iterator) this.blocks.set(cid.toString(), bytes)
    this.pinned.add(rootCid)
  }
  async hasContent(rootCid: string) { return this.pinned.has(rootCid) }
  async verifyDag(rootCid: string) {
    return this.pinned.has(rootCid)
      ? { valid: true }
      : { valid: false, error: 'not pinned' }
  }
  async hasBlock(cid: string) { return this.blocks.has(cid) }
  async putBlock(cid: string, bytes: Uint8Array) { this.blocks.set(cid, bytes) }
}

describe('runExport', () => {
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

  it('exports multiple uploads with concurrency', async () => {
    const leaf1 = await makeRawBlock('file-a')
    const root1 = await makeDagPBNode([leaf1])
    const car1 = await buildCarBytes([root1, leaf1], [root1])

    const leaf2 = await makeRawBlock('file-b')
    const root2 = await makeDagPBNode([leaf2])
    const car2 = await buildCarBytes([root2, leaf2], [root2])

    const carMap = new Map<string, Uint8Array>([
      [root1.cid.toString(), car1],
      [root2.cid.toString(), car2],
    ])
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const cidMatch = url.pathname.match(/\/ipfs\/([^?]+)/)
      if (cidMatch && carMap.has(cidMatch[1])) {
        return new Response(carMap.get(cidMatch[1]), {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.ipld.car' },
        })
      }
      return new Response('not found', { status: 404 })
    }) as any
    const gatewayUrl = 'http://gateway.test'

    const backend = new MemoryBackend()
    queue.add({ rootCid: root1.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })
    queue.add({ rootCid: root2.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })

    try {
      await runExport({
        queue,
        manifest,
        backends: [backend],
        gatewayUrl,
        concurrency: 2,
        spaceNames: ['TestSpace'],
      })

      expect(queue.getStatus(root1.cid.toString(), 'memory')).toBe('complete')
      expect(queue.getStatus(root2.cid.toString(), 'memory')).toBe('complete')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

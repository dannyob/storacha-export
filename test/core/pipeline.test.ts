import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { exportUpload } from '../../src/core/pipeline.js'
import { UploadQueue } from '../../src/core/queue.js'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from './blocks.test.js'
import http from 'node:http'
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

    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
      res.end(carBytes)
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const gatewayUrl = `http://127.0.0.1:${(server.address() as any).port}`

    const backend = new MemoryBackend()
    queue.add({ rootCid: root.cid.toString(), spaceDid: 'did:key:test', spaceName: 'Test', backend: 'memory' })

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

    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExport } from '../../src/phases/export.js'
import { UploadQueue } from '../../src/core/queue.js'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from '../core/blocks.test.js'
import http from 'node:http'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { ExportBackend } from '../../src/backends/interface.js'
import type { BlockStream } from '../../src/core/blocks.js'

const TEST_DB = '/tmp/storacha-v2-export-phase-test.db'

class MemoryBackend implements ExportBackend {
  name = 'memory'
  blocks = new Map<string, Uint8Array>()
  pinned = new Set<string>()
  async importCar(rootCid: string, blocks: BlockStream) {
    for await (const block of blocks) this.blocks.set(block.cid.toString(), block.bytes)
    this.pinned.add(rootCid)
  }
  async hasContent(rootCid: string) { return this.pinned.has(rootCid) }
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

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const cidMatch = url.pathname.match(/\/ipfs\/([^?]+)/)
      if (cidMatch && carMap.has(cidMatch[1])) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
        res.end(carMap.get(cidMatch[1]))
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const gatewayUrl = `http://127.0.0.1:${(server.address() as any).port}`

    const backend = new MemoryBackend()
    queue.add({ rootCid: root1.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })
    queue.add({ rootCid: root2.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })

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

    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

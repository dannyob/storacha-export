import { describe, it, expect, afterEach, vi } from 'vitest'
import { createDatabase } from '../src/core/db.js'
import { UploadQueue } from '../src/core/queue.js'
import { BlockManifest } from '../src/core/manifest.js'
import { ShardStore } from '../src/core/shards.js'
import { GatewayFetcher } from '../src/core/fetcher.js'
import { runExport } from '../src/phases/export.js'
import { LocalBackend } from '../src/backends/local.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from './core/blocks.test.js'
import { CarBlockIterator } from '@ipld/car'
import fs from 'node:fs'

const TEST_DB = '/tmp/storacha-v2-e2e-shards.db'
const TEST_OUTPUT = '/tmp/storacha-v2-e2e-shards-output'

afterEach(() => {
  try { fs.unlinkSync(TEST_DB) } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  try { fs.rmSync(TEST_OUTPUT, { recursive: true }) } catch {}
})

describe('shard-based export e2e', () => {
  it('fetches two shards and produces a single CAR with correct root and all blocks', async () => {
    const db = createDatabase(TEST_DB)
    const queue = new UploadQueue(db)
    const manifest = new BlockManifest(db)
    const shardStore = new ShardStore(db)

    // Build a DAG: root -> [leaf1, leaf2]
    const leaf1 = await makeRawBlock('e2e-data-1')
    const leaf2 = await makeRawBlock('e2e-data-2')
    const root = await makeDagPBNode([leaf1, leaf2])
    const rootCid = root.cid.toString()

    // Split into two shards
    const shard1Car = await buildCarBytes([root, leaf1], [root])
    const shard2Car = await buildCarBytes([leaf2], [])

    // Insert shard records
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard-e2e-1', shardSize: shard1Car.length, shardOrder: 0, spaceDid: 'did:key:z' })
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard-e2e-2', shardSize: shard2Car.length, shardOrder: 1, spaceDid: 'did:key:z' })

    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'E2E', backend: 'local' })

    // Mock gateway
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('bafyshard-e2e-1')) return new Response(shard1Car, { status: 200 })
      if (url.pathname.includes('bafyshard-e2e-2')) return new Response(shard2Car, { status: 200 })
      return new Response('not found', { status: 404 })
    }) as any

    const backend = new LocalBackend({ outputDir: TEST_OUTPUT })
    await backend.init()

    try {
      await runExport({
        queue,
        manifest,
        backends: [backend],
        gatewayUrl: 'http://gateway.test',
        concurrency: 1,
        spaceNames: ['E2E'],
        shardStore,
      })

      // Check the output CAR file
      expect(queue.getStatus(rootCid, 'local')).toBe('complete')

      const carPath = `${TEST_OUTPUT}/${rootCid}.car`
      expect(fs.existsSync(carPath)).toBe(true)

      // Read the CAR and verify its contents
      const carStream = fs.createReadStream(carPath)
      const iterator = await CarBlockIterator.fromIterable(carStream)
      const blockCids = new Set<string>()
      for await (const { cid } of iterator) {
        blockCids.add(cid.toString())
      }

      expect(blockCids.size).toBe(3)
      expect(blockCids.has(root.cid.toString())).toBe(true)
      expect(blockCids.has(leaf1.cid.toString())).toBe(true)
      expect(blockCids.has(leaf2.cid.toString())).toBe(true)

      // Verify DAG traversal
      const verifyResult = await backend.verifyDag(rootCid)
      expect(verifyResult.valid).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      db.close()
    }
  })
})

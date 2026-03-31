import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalBackend } from '../../src/backends/local.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from '../core/blocks.test.js'
import { CarBlockIterator } from '@ipld/car'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Block } from '../../src/core/blocks.js'

describe('LocalBackend', () => {
  let tmpDir: string
  let backend: LocalBackend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-local-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has name "local"', () => {
    expect(backend.name).toBe('local')
  })

  it('hasContent returns false for missing CID', async () => {
    expect(await backend.hasContent('bafynothere')).toBe(false)
  })

  it('importCar writes a valid CAR file and hasContent returns true', async () => {
    const leaf = await makeRawBlock('test-data')
    const root = await makeDagPBNode([leaf])

    async function* blocks(): AsyncIterable<Block> {
      yield root
      yield leaf
    }

    await backend.importCar(root.cid.toString(), blocks())

    const carPath = path.join(tmpDir, `${root.cid.toString()}.car`)
    expect(fs.existsSync(carPath)).toBe(true)
    expect(await backend.hasContent(root.cid.toString())).toBe(true)
  })

  it('creates output directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'sub', 'dir')
    const be = new LocalBackend({ outputDir: nested })
    await be.init()
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('verifyDag checks CAR is parseable', async () => {
    const leaf = await makeRawBlock('verify-test')
    const root = await makeDagPBNode([leaf])

    async function* blocks(): AsyncIterable<Block> {
      yield root
      yield leaf
    }

    await backend.importCar(root.cid.toString(), blocks())
    const result = await backend.verifyDag!(root.cid.toString())
    expect(result.valid).toBe(true)
  })

  it('putBlock writes a block to a .car.repair sidecar', async () => {
    const leaf = await makeRawBlock('put-test')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()

    async function* rootBlocks(): AsyncIterable<Block> { yield root }
    await backend.importCar(rootCid, rootBlocks())

    await backend.putBlock!(leaf.cid.toString(), leaf.bytes, rootCid)
    await backend.closeRepairWriter(rootCid)

    const repairPath = path.join(tmpDir, `${rootCid}.car.repair`)
    expect(fs.existsSync(repairPath)).toBe(true)

    const data = fs.readFileSync(repairPath)
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(data) })()
    )
    const repairBlocks: any[] = []
    for await (const b of iter) repairBlocks.push(b)
    expect(repairBlocks).toHaveLength(1)
    expect(repairBlocks[0].cid.toString()).toBe(leaf.cid.toString())
  })

  it('putBlock appends multiple blocks to the same sidecar', async () => {
    const leaf1 = await makeRawBlock('multi-1')
    const leaf2 = await makeRawBlock('multi-2')
    const root = await makeDagPBNode([leaf1, leaf2])
    const rootCid = root.cid.toString()

    async function* rootBlocks(): AsyncIterable<Block> { yield root }
    await backend.importCar(rootCid, rootBlocks())

    await backend.putBlock!(leaf1.cid.toString(), leaf1.bytes, rootCid)
    await backend.putBlock!(leaf2.cid.toString(), leaf2.bytes, rootCid)
    await backend.closeRepairWriter(rootCid)

    const repairPath = path.join(tmpDir, `${rootCid}.car.repair`)
    const data = fs.readFileSync(repairPath)
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(data) })()
    )
    const repairBlocks: any[] = []
    for await (const b of iter) repairBlocks.push(b)
    expect(repairBlocks).toHaveLength(2)
  })
})

describe('LocalBackend repair', () => {
  let tmpDir: string
  let backend: LocalBackend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-local-repair-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('repairs a truncated CAR by reading from disk + fetching missing blocks', async () => {
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createDatabase(dbPath)
    const manifest = new BlockManifest(db)

    const leaf1 = await makeRawBlock('data-1')
    const leaf2 = await makeRawBlock('data-2')
    const leaf3 = await makeRawBlock('data-3')
    const root = await makeDagPBNode([leaf1, leaf2, leaf3])

    // Write a truncated CAR (root + leaf1 only)
    const truncatedCar = await buildCarBytes([root, leaf1], [root])
    const carPath = path.join(tmpDir, `${root.cid.toString()}.car`)
    fs.writeFileSync(carPath, truncatedCar)

    // Set up manifest as if we'd parsed the truncated CAR
    manifest.markSeen(root.cid.toString(), root.cid.toString(), 0x70)
    manifest.markSeen(root.cid.toString(), leaf1.cid.toString(), 0x55)
    manifest.addLink(root.cid.toString(), leaf1.cid.toString(), 0x55, root.cid.toString())
    manifest.addLink(root.cid.toString(), leaf2.cid.toString(), 0x55, root.cid.toString())
    manifest.addLink(root.cid.toString(), leaf3.cid.toString(), 0x55, root.cid.toString())

    // Repair — provide a fetchBlock that serves missing leaves
    const blockMap = new Map([
      [leaf2.cid.toString(), leaf2],
      [leaf3.cid.toString(), leaf3],
    ])

    const result = await backend.repair(
      root.cid.toString(),
      manifest,
      async (cid) => {
        const block = blockMap.get(cid)
        if (!block) throw new Error('not found')
        return block
      },
    )

    expect(result).toBe(true)

    // Verify the repaired CAR is complete
    const verifyResult = await backend.verifyDag!(root.cid.toString())
    expect(verifyResult.valid).toBe(true)

    // Verify it has all blocks
    const repaired = fs.readFileSync(carPath)
    const iterator = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(repaired) })()
    )
    let blockCount = 0
    for await (const _ of iterator) blockCount++
    expect(blockCount).toBe(4) // root + 3 leaves

    db.close()
  })
})

describe('LocalBackend mergeRepairCar', () => {
  let tmpDir: string
  let backend: LocalBackend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-local-merge-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('merges main CAR and repair sidecar into a deduplicated CAR', async () => {
    const leaf1 = await makeRawBlock('merge-1')
    const leaf2 = await makeRawBlock('merge-2')
    const leaf3 = await makeRawBlock('merge-3')
    const root = await makeDagPBNode([leaf1, leaf2, leaf3])
    const rootCid = root.cid.toString()

    // Write main CAR with root + leaf1
    const mainCar = await buildCarBytes([root, leaf1], [root])
    fs.writeFileSync(path.join(tmpDir, `${rootCid}.car`), mainCar)

    // Write repair sidecar with leaf1 (duplicate) + leaf2 + leaf3
    await backend.putBlock!(leaf1.cid.toString(), leaf1.bytes, rootCid)
    await backend.putBlock!(leaf2.cid.toString(), leaf2.bytes, rootCid)
    await backend.putBlock!(leaf3.cid.toString(), leaf3.bytes, rootCid)
    await backend.closeRepairWriter(rootCid)

    // Merge
    await backend.mergeRepairCar(rootCid)

    // .car.repair should be gone
    expect(fs.existsSync(path.join(tmpDir, `${rootCid}.car.repair`))).toBe(false)

    // Final CAR should have exactly 4 blocks (deduplicated)
    const finalData = fs.readFileSync(path.join(tmpDir, `${rootCid}.car`))
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(finalData) })()
    )
    const cids = new Set<string>()
    for await (const b of iter) cids.add(b.cid.toString())
    expect(cids.size).toBe(4)
    expect(cids.has(root.cid.toString())).toBe(true)
    expect(cids.has(leaf1.cid.toString())).toBe(true)
    expect(cids.has(leaf2.cid.toString())).toBe(true)
    expect(cids.has(leaf3.cid.toString())).toBe(true)
  })

  it('mergeRepairCar is a no-op when no sidecar exists', async () => {
    const leaf = await makeRawBlock('noop-test')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()

    const mainCar = await buildCarBytes([root, leaf], [root])
    const carPath = path.join(tmpDir, `${rootCid}.car`)
    fs.writeFileSync(carPath, mainCar)

    const sizeBefore = fs.statSync(carPath).size
    await backend.mergeRepairCar(rootCid)
    const sizeAfter = fs.statSync(carPath).size
    expect(sizeAfter).toBe(sizeBefore)
  })
})

import { describe, it, expect } from 'vitest'
import { carToBlockStream, blockStreamToArray, trackBlocks } from '../../src/core/blocks.js'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import { CarWriter } from '@ipld/car'
import * as dagPB from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

async function makeRawBlock(data: string): Promise<{ cid: CID; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(data)
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, 0x55, hash)
  return { cid, bytes }
}

async function makeDagPBNode(links: { cid: CID; bytes: Uint8Array }[]): Promise<{ cid: CID; bytes: Uint8Array }> {
  const pbLinks = links.map((l, i) => ({
    Hash: l.cid,
    Name: `file-${i}`,
    Tsize: l.bytes.length,
  }))
  const bytes = dagPB.encode(dagPB.prepare({ Data: new Uint8Array([8, 1]), Links: pbLinks }))
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, 0x70, hash)
  return { cid, bytes }
}

async function buildCarBytes(blocks: { cid: CID; bytes: Uint8Array }[], roots: { cid: CID }[]): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots.map(r => r.cid))
  const chunks: Uint8Array[] = []
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()
  for (const { cid, bytes } of blocks) await writer.put({ cid, bytes })
  await writer.close()
  await drain
  return Buffer.concat(chunks)
}

// Helper to collect a BlockStream into an array
export { makeRawBlock, makeDagPBNode, buildCarBytes }

describe('carToBlockStream', () => {
  it('parses a valid CAR into blocks', async () => {
    const leaf1 = await makeRawBlock('hello')
    const leaf2 = await makeRawBlock('world')
    const root = await makeDagPBNode([leaf1, leaf2])
    const carBytes = await buildCarBytes([root, leaf1, leaf2], [root])

    const blocks = await blockStreamToArray(carToBlockStream(carBytes))

    expect(blocks).toHaveLength(3)
    expect(blocks[0].cid.toString()).toBe(root.cid.toString())
    expect(blocks[1].cid.toString()).toBe(leaf1.cid.toString())
    expect(blocks[2].cid.toString()).toBe(leaf2.cid.toString())
  })

  it('yields blocks from a truncated CAR without throwing', async () => {
    const leaf1 = await makeRawBlock('hello')
    const leaf2 = await makeRawBlock('world')
    const root = await makeDagPBNode([leaf1, leaf2])
    const carBytes = await buildCarBytes([root, leaf1, leaf2], [root])

    // Truncate at 80% of the file (60% cuts mid-root-block; 80% reliably yields root but not all blocks)
    const truncated = carBytes.slice(0, Math.floor(carBytes.length * 0.8))

    const blocks = await blockStreamToArray(carToBlockStream(truncated))

    // Should get at least the root and maybe leaf1, but not throw
    expect(blocks.length).toBeGreaterThan(0)
    expect(blocks.length).toBeLessThan(3)
  })
})

describe('trackBlocks', () => {
  it('records blocks and links in manifest as they pass through', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-track-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createDatabase(dbPath)
    const manifest = new BlockManifest(db)

    const leaf1 = await makeRawBlock('hello')
    const leaf2 = await makeRawBlock('world')
    const root = await makeDagPBNode([leaf1, leaf2])
    const carBytes = await buildCarBytes([root, leaf1, leaf2], [root])

    const source = carToBlockStream(carBytes)
    const tracked = trackBlocks(source, root.cid.toString(), manifest)
    const blocks = await blockStreamToArray(tracked)

    // All blocks pass through
    expect(blocks).toHaveLength(3)

    // Manifest has all blocks as seen
    expect(manifest.isSeen(root.cid.toString(), root.cid.toString())).toBe(true)
    expect(manifest.isSeen(root.cid.toString(), leaf1.cid.toString())).toBe(true)
    expect(manifest.isSeen(root.cid.toString(), leaf2.cid.toString())).toBe(true)

    // Links were extracted from the dag-pb root
    const progress = manifest.getProgress(root.cid.toString())
    expect(progress.seen).toBe(3)
    expect(progress.missing).toBe(0)

    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('handles truncated CARs — records what it can', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-track-trunc-'))
    const dbPath = path.join(tmpDir, 'test.db')
    const db = createDatabase(dbPath)
    const manifest = new BlockManifest(db)

    const leaf1 = await makeRawBlock('hello')
    const leaf2 = await makeRawBlock('world')
    const root = await makeDagPBNode([leaf1, leaf2])
    const carBytes = await buildCarBytes([root, leaf1, leaf2], [root])
    const truncated = carBytes.slice(0, Math.floor(carBytes.length * 0.8))

    const source = carToBlockStream(truncated)
    const tracked = trackBlocks(source, root.cid.toString(), manifest)
    await blockStreamToArray(tracked)

    // Root's dag-pb links should be recorded even if leaves are missing
    const progress = manifest.getProgress(root.cid.toString())
    expect(progress.seen).toBeGreaterThan(0)
    // At least the root was seen + its links were discovered
    expect(progress.total).toBeGreaterThanOrEqual(progress.seen)

    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

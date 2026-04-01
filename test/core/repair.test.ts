import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { repairUpload } from '../../src/core/repair.js'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode } from './blocks.test.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'

const TEST_DB = '/tmp/storacha-v2-repair-test.db'
const RAW = 0x55
const DAG_PB = 0x70

describe('repairUpload', () => {
  let db: Database.Database
  let manifest: BlockManifest

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    manifest = new BlockManifest(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('returns null when no blocks are missing', async () => {
    manifest.markSeen('bafyRoot', 'bafyRoot', DAG_PB)
    manifest.addLink('bafyRoot', 'bafyLeaf1', RAW, 'bafyRoot')
    manifest.markSeen('bafyRoot', 'bafyLeaf1', RAW)

    const result = await repairUpload('bafyRoot', manifest, async () => {
      throw new Error('should not be called')
    }, { throttleMs: 0 })
    expect(result).toBeNull()
  })

  it('fetches missing raw blocks', async () => {
    const leaf1 = await makeRawBlock('data1')
    const leaf2 = await makeRawBlock('data2')

    manifest.markSeen('bafyRoot', 'bafyRoot', DAG_PB)
    manifest.addLink('bafyRoot', leaf1.cid.toString(), RAW, 'bafyRoot')
    manifest.addLink('bafyRoot', leaf2.cid.toString(), RAW, 'bafyRoot')

    const fetchedCids: string[] = []
    const result = await repairUpload('bafyRoot', manifest, async (cidStr) => {
      fetchedCids.push(cidStr)
      if (cidStr === leaf1.cid.toString()) return { cid: leaf1.cid, bytes: leaf1.bytes }
      if (cidStr === leaf2.cid.toString()) return { cid: leaf2.cid, bytes: leaf2.bytes }
      throw new Error('unknown CID')
    }, { throttleMs: 0 })

    expect(result).not.toBeNull()
    expect(fetchedCids).toHaveLength(2)
    expect(result!.complete).toBe(true)
    expect(result!.fetched).toBe(2)
  })

  it('fetches missing dag-pb nodes and discovers their links', async () => {
    const leaf1 = await makeRawBlock('data1')
    const leaf2 = await makeRawBlock('data2')
    const intermediate = await makeDagPBNode([leaf1, leaf2])

    // Root is seen, intermediate is linked but unseen
    manifest.markSeen('bafyRoot', 'bafyRoot', DAG_PB)
    manifest.addLink('bafyRoot', intermediate.cid.toString(), DAG_PB, 'bafyRoot')

    const blockMap = new Map([
      [intermediate.cid.toString(), intermediate],
      [leaf1.cid.toString(), leaf1],
      [leaf2.cid.toString(), leaf2],
    ])

    const result = await repairUpload('bafyRoot', manifest, async (cidStr) => {
      const block = blockMap.get(cidStr)
      if (!block) throw new Error('not found')
      return block
    }, { throttleMs: 0 })

    expect(result).not.toBeNull()
    // Pass 1: fetched intermediate, discovered leaf1+leaf2
    // Pass 2: fetched leaf1+leaf2
    expect(result!.fetched).toBe(3)
    expect(result!.complete).toBe(true)
  })
})

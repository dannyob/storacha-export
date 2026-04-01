import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BlockManifest } from '../../src/core/manifest.js'
import { createDatabase } from '../../src/core/db.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'

const TEST_DB = '/tmp/storacha-v2-manifest-test.db'
const DAG_PB = 0x70
const RAW = 0x55

describe('BlockManifest', () => {
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

  it('records a seen block', () => {
    manifest.markSeen('bafyRoot', 'bafyBlock1', RAW)
    expect(manifest.isSeen('bafyRoot', 'bafyBlock1')).toBe(true)
  })

  it('records a linked but unseen block', () => {
    manifest.addLink('bafyRoot', 'bafyLeaf1', RAW, 'bafyParent')
    expect(manifest.isSeen('bafyRoot', 'bafyLeaf1')).toBe(false)
  })

  it('getMissing returns unseen blocks', () => {
    manifest.markSeen('bafyRoot', 'bafyBlock1', DAG_PB)
    manifest.addLink('bafyRoot', 'bafyLeaf1', RAW, 'bafyBlock1')
    manifest.addLink('bafyRoot', 'bafyLeaf2', RAW, 'bafyBlock1')

    const missing = manifest.getMissing('bafyRoot')
    expect(missing).toHaveLength(2)
    expect(missing.map(m => m.block_cid).sort()).toEqual(['bafyLeaf1', 'bafyLeaf2'])
  })

  it('getMissingDagPB returns only missing dag-pb nodes', () => {
    manifest.addLink('bafyRoot', 'bafyIntermediate', DAG_PB, 'bafyRoot')
    manifest.addLink('bafyRoot', 'bafyLeaf', RAW, 'bafyRoot')

    const missingPB = manifest.getMissingDagPB('bafyRoot')
    expect(missingPB).toHaveLength(1)
    expect(missingPB[0].block_cid).toBe('bafyIntermediate')
  })

  it('isRepairable returns true when only raw blocks missing', () => {
    manifest.markSeen('bafyRoot', 'bafyRoot', DAG_PB)
    manifest.addLink('bafyRoot', 'bafyLeaf1', RAW, 'bafyRoot')
    expect(manifest.isRepairable('bafyRoot')).toBe(true)
  })

  it('isRepairable returns false when dag-pb nodes missing', () => {
    manifest.markSeen('bafyRoot', 'bafyRoot', DAG_PB)
    manifest.addLink('bafyRoot', 'bafyIntermediate', DAG_PB, 'bafyRoot')
    expect(manifest.isRepairable('bafyRoot')).toBe(false)
  })

  it('markSeen updates existing unseen entry', () => {
    manifest.addLink('bafyRoot', 'bafyLeaf1', RAW, 'bafyParent')
    expect(manifest.isSeen('bafyRoot', 'bafyLeaf1')).toBe(false)

    manifest.markSeen('bafyRoot', 'bafyLeaf1', RAW)
    expect(manifest.isSeen('bafyRoot', 'bafyLeaf1')).toBe(true)
  })

  it('getProgress returns seen/total counts', () => {
    manifest.markSeen('bafyRoot', 'bafyRoot', DAG_PB)
    manifest.addLink('bafyRoot', 'bafyLeaf1', RAW, 'bafyRoot')
    manifest.addLink('bafyRoot', 'bafyLeaf2', RAW, 'bafyRoot')
    manifest.markSeen('bafyRoot', 'bafyLeaf1', RAW)

    const progress = manifest.getProgress('bafyRoot')
    expect(progress.seen).toBe(2)
    expect(progress.total).toBe(3)
    expect(progress.missing).toBe(1)
  })

  it('clear removes all blocks for a root', () => {
    manifest.markSeen('bafyRoot', 'bafyBlock1', RAW)
    manifest.clear('bafyRoot')
    expect(manifest.getProgress('bafyRoot').total).toBe(0)
  })
})

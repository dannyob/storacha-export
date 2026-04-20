import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ShardStore } from '../../src/core/shards.js'
import { createDatabase } from '../../src/core/db.js'
import fs from 'node:fs'

const TEST_DB = '/tmp/storacha-shards-test.db'

describe('ShardStore', () => {
  let db: ReturnType<typeof createDatabase>
  let store: ShardStore

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    store = new ShardStore(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('inserts and retrieves shards for an upload', () => {
    store.insertShards('bafyroot1', 'did:key:space1', [
      { shardCid: 'bafyshard1', locationUrl: 'https://r2.example/a', size: 1000, order: 0 },
      { shardCid: 'bafyshard2', locationUrl: 'https://r2.example/b', size: 2000, order: 1 },
    ])

    const shards = store.getShardsForUpload('bafyroot1')
    expect(shards).toHaveLength(2)
    expect(shards[0].shard_cid).toBe('bafyshard1')
    expect(shards[0].location_url).toBe('https://r2.example/a')
    expect(shards[1].shard_order).toBe(1)
  })

  it('returns empty array for unknown upload', () => {
    expect(store.getShardsForUpload('bafyunknown')).toEqual([])
  })

  it('skips duplicates on re-insert', () => {
    store.insertShards('bafyroot1', 'did:key:space1', [
      { shardCid: 'bafyshard1', locationUrl: 'https://r2.example/a', size: 1000, order: 0 },
    ])
    store.insertShards('bafyroot1', 'did:key:space1', [
      { shardCid: 'bafyshard1', locationUrl: 'https://r2.example/a', size: 1000, order: 0 },
    ])
    expect(store.getShardsForUpload('bafyroot1')).toHaveLength(1)
  })

  it('hasResolvedShards returns true only when shards exist', () => {
    expect(store.hasResolvedShards('bafyroot1')).toBe(false)
    store.insertShards('bafyroot1', 'did:key:space1', [
      { shardCid: 'bafyshard1', locationUrl: 'https://r2.example/a', size: 1000, order: 0 },
    ])
    expect(store.hasResolvedShards('bafyroot1')).toBe(true)
  })
})

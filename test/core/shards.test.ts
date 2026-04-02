import { describe, it, expect, afterEach } from 'vitest'
import { createDatabase } from '../../src/core/db.js'
import { cidFromBlobDigest, ShardStore } from '../../src/core/shards.js'
import { sha256 } from 'multiformats/hashes/sha2'
import fs from 'node:fs'

const TEST_DB = '/tmp/storacha-v2-shards-test.db'

afterEach(() => {
  try { fs.unlinkSync(TEST_DB) } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
})

describe('cidFromBlobDigest', () => {
  it('computes a raw CIDv1 from a sha2-256 multihash', async () => {
    const data = new TextEncoder().encode('hello')
    const mh = await sha256.digest(data)
    const cid = cidFromBlobDigest(mh.bytes)
    expect(cid).not.toBeNull()
    expect(cid!.code).toBe(0x55) // raw codec
    expect(cid!.version).toBe(1)
    expect(cid!.toString()).toMatch(/^bafkr/) // raw codec CIDv1 in base32
  })

  it('returns null for non-sha256 multihash', () => {
    // varint 0xb220 = blake2b-256 — encodes to 3 bytes [0xa0, 0xe4, 0x02]
    const fakeDigest = new Uint8Array(35)
    fakeDigest[0] = 0xa0; fakeDigest[1] = 0xe4; fakeDigest[2] = 0x02
    const cid = cidFromBlobDigest(fakeDigest)
    expect(cid).toBeNull()
  })
})

describe('ShardStore', () => {
  it('inserts and retrieves blobs', () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)
    store.insertBlob({
      digest: 'abc123',
      size: 50000,
      spaceDid: 'did:key:z',
      cid: 'bafyabc',
      insertedAt: '2026-01-01',
    })
    const blobs = store.getUnfetchedCandidateIndexes('did:key:z')
    expect(blobs).toHaveLength(1)
    expect(blobs[0].cid).toBe('bafyabc')
    db.close()
  })

  it('skips duplicate blobs on insert', () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)
    const blob = { digest: 'abc', size: 100, spaceDid: 'did:key:z', cid: 'bafyabc', insertedAt: '2026-01-01' }
    store.insertBlob(blob)
    store.insertBlob(blob)
    const count = db.prepare('SELECT COUNT(*) as c FROM blobs').get() as any
    expect(count.c).toBe(1)
    db.close()
  })

  it('candidate indexes are blobs under 200KB that have not been fetched', () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)
    store.insertBlob({ digest: 'small', size: 500, spaceDid: 'did:key:z', cid: 'bafysmall', insertedAt: '' })
    store.insertBlob({ digest: 'large', size: 50_000_000, spaceDid: 'did:key:z', cid: 'bafylarge', insertedAt: '' })
    store.insertBlob({ digest: 'fetched', size: 500, spaceDid: 'did:key:z', cid: 'bafyfetched', insertedAt: '' })
    store.markFetched('bafyfetched', 'did:key:z', false)

    const candidates = store.getUnfetchedCandidateIndexes('did:key:z')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].cid).toBe('bafysmall')
    db.close()
  })

  it('inserts and retrieves shards for an upload', () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)
    store.insertShard({ uploadRoot: 'bafyroot', shardCid: 'bafyshard1', shardSize: 100000, shardOrder: 0, spaceDid: 'did:key:z' })
    store.insertShard({ uploadRoot: 'bafyroot', shardCid: 'bafyshard2', shardSize: 200000, shardOrder: 1, spaceDid: 'did:key:z' })

    const shards = store.getShardsForUpload('bafyroot')
    expect(shards).toHaveLength(2)
    expect(shards[0].shard_cid).toBe('bafyshard1')
    expect(shards[1].shard_cid).toBe('bafyshard2')
    db.close()
  })

  it('returns empty array for uploads with no shards', () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)
    expect(store.getShardsForUpload('bafynothing')).toEqual([])
    db.close()
  })
})

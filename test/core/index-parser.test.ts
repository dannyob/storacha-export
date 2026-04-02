import { describe, it, expect } from 'vitest'
import { parseIndexBlob } from '../../src/core/index-parser.js'
import { CarWriter } from '@ipld/car'
import * as dagCBOR from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

/** Build a synthetic index blob CAR with the index/sharded/dag@0.1 structure */
async function buildIndexBlob(contentRoot: string, shardCids: string[]): Promise<Uint8Array> {
  const indexData = {
    'index/sharded/dag@0.1': {
      content: CID.parse(contentRoot),
      shards: shardCids.map(c => CID.parse(c)),
    },
  }
  const bytes = dagCBOR.encode(indexData)
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, dagCBOR.code, hash)

  const { writer, out } = CarWriter.create([cid])
  const chunks: Uint8Array[] = []
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()
  await writer.put({ cid, bytes })
  await writer.close()
  await drain
  return Buffer.concat(chunks)
}

describe('parseIndexBlob', () => {
  it('parses a single-shard index', async () => {
    const fakeRoot = CID.create(1, 0x70, await sha256.digest(new TextEncoder().encode('root')))
    const fakeShard = CID.create(1, 0x55, await sha256.digest(new TextEncoder().encode('shard')))

    const carBytes = await buildIndexBlob(fakeRoot.toString(), [fakeShard.toString()])
    const result = await parseIndexBlob(carBytes)

    expect(result).not.toBeNull()
    expect(result!.contentRoot).toBe(fakeRoot.toString())
    expect(result!.shardCids).toEqual([fakeShard.toString()])
  })

  it('parses a multi-shard index preserving order', async () => {
    const fakeRoot = CID.create(1, 0x70, await sha256.digest(new TextEncoder().encode('root2')))
    const shard1 = CID.create(1, 0x55, await sha256.digest(new TextEncoder().encode('s1')))
    const shard2 = CID.create(1, 0x55, await sha256.digest(new TextEncoder().encode('s2')))
    const shard3 = CID.create(1, 0x55, await sha256.digest(new TextEncoder().encode('s3')))

    const carBytes = await buildIndexBlob(fakeRoot.toString(), [shard1.toString(), shard2.toString(), shard3.toString()])
    const result = await parseIndexBlob(carBytes)

    expect(result).not.toBeNull()
    expect(result!.shardCids).toHaveLength(3)
    expect(result!.shardCids[0]).toBe(shard1.toString())
    expect(result!.shardCids[2]).toBe(shard3.toString())
  })

  it('returns null for a non-index CAR (raw data shard)', async () => {
    const data = new TextEncoder().encode('just some data')
    const hash = await sha256.digest(data)
    const cid = CID.create(1, 0x55, hash)
    const { writer, out } = CarWriter.create([cid])
    const chunks: Uint8Array[] = []
    const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()
    await writer.put({ cid, bytes: data })
    await writer.close()
    await drain

    const result = await parseIndexBlob(Buffer.concat(chunks))
    expect(result).toBeNull()
  })

  it('returns null for garbage bytes', async () => {
    const result = await parseIndexBlob(new Uint8Array([1, 2, 3, 4]))
    expect(result).toBeNull()
  })
})

import { describe, it, expect } from 'vitest'
import { resolveUploadShards } from '../../src/core/shard-resolver.js'
import { base58btc } from 'multiformats/bases/base58'
import { sha256 } from 'multiformats/hashes/sha2'
import { CID } from 'multiformats/cid'

async function makeCID(content: string) {
  const hash = await sha256.digest(new TextEncoder().encode(content))
  return CID.createV1(0x55, hash)
}

describe('resolveUploadShards', () => {
  it('resolves shards with location URLs from indexing service', async () => {
    const shard1 = await makeCID('shard-1')
    const shard2 = await makeCID('shard-2')

    const client = {
      capability: {
        upload: {
          shard: {
            list: async () => ({ results: [shard1, shard2], cursor: undefined }),
          },
        },
      },
    }

    const indexer = {
      queryClaims: async () => ({
        ok: {
          claims: new Map([
            ['loc-1', {
              type: 'assert/location',
              content: { multihash: shard1.multihash },
              location: [new URL('https://r2.example/shard-1')],
              range: { length: 5000 },
            }],
            ['loc-2', {
              type: 'assert/location',
              content: { multihash: shard2.multihash },
              location: [new URL('https://r2.example/shard-2')],
              range: { length: 3000 },
            }],
          ]),
        },
      }),
    }

    const result = await resolveUploadShards('bafyroot', client as any, indexer as any)
    expect(result).toHaveLength(2)
    expect(result![0].shardCid).toBe(shard1.toString())
    expect(result![0].locationUrl).toBe('https://r2.example/shard-1')
    expect(result![0].size).toBe(5000)
    expect(result![0].order).toBe(0)
    expect(result![1].shardCid).toBe(shard2.toString())
    expect(result![1].locationUrl).toBe('https://r2.example/shard-2')
  })

  it('returns null when no shards found', async () => {
    const client = {
      capability: {
        upload: {
          shard: {
            list: async () => ({ results: [], cursor: undefined }),
          },
        },
      },
    }
    const indexer = { queryClaims: async () => ({ ok: { claims: new Map() } }) }

    const result = await resolveUploadShards('bafyroot', client as any, indexer as any)
    expect(result).toBeNull()
  })

  it('returns null when location claims are missing', async () => {
    const shard1 = await makeCID('shard-no-claim')
    const client = {
      capability: {
        upload: {
          shard: {
            list: async () => ({ results: [shard1], cursor: undefined }),
          },
        },
      },
    }
    const indexer = {
      queryClaims: async () => ({ ok: { claims: new Map() } }),
    }

    const result = await resolveUploadShards('bafyroot', client as any, indexer as any)
    expect(result).toBeNull()
  })
})

import { describe, it, expect, afterEach, vi } from 'vitest'
import { discoverShards } from '../../src/phases/discover.js'
import { ShardStore } from '../../src/core/shards.js'
import { createDatabase } from '../../src/core/db.js'
import { GatewayFetcher } from '../../src/core/fetcher.js'
import { CarWriter } from '@ipld/car'
import * as dagCBOR from '@ipld/dag-cbor'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import fs from 'node:fs'
import type Database from 'better-sqlite3'

const TEST_DB = '/tmp/storacha-v2-discover-shards-test.db'

afterEach(() => {
  try { fs.unlinkSync(TEST_DB) } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
})

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

describe('discoverShards', () => {
  it('enumerates blobs, parses indexes, and populates shards table', async () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)

    const rootHash = await sha256.digest(new TextEncoder().encode('upload-root'))
    const uploadRoot = CID.create(1, 0x70, rootHash)
    const shardHash = await sha256.digest(new TextEncoder().encode('data-shard'))
    const shardCid = CID.create(1, 0x55, shardHash)

    const indexCarBytes = await buildIndexBlob(uploadRoot.toString(), [shardCid.toString()])
    const indexBlobHash = await sha256.digest(indexCarBytes)
    const indexBlobCid = CID.create(1, 0x55, indexBlobHash)

    const mockClient = {
      setCurrentSpace: vi.fn(),
      capability: {
        blob: {
          list: vi.fn().mockResolvedValue({
            results: [
              { blob: { digest: indexBlobHash.bytes, size: indexCarBytes.length }, insertedAt: '2026-01-01' },
              { blob: { digest: shardHash.bytes, size: 50_000_000 }, insertedAt: '2026-01-01' },
            ],
            cursor: undefined,
          }),
        },
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes(indexBlobCid.toString())) {
        return new Response(indexCarBytes, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const fetcher = new GatewayFetcher('http://gateway.test')
    const spaces = [{ did: 'did:key:z', name: 'TestSpace' }]

    try {
      await discoverShards(mockClient, spaces, store, fetcher)

      const shards = store.getShardsForUpload(uploadRoot.toString())
      expect(shards).toHaveLength(1)
      expect(shards[0].shard_cid).toBe(shardCid.toString())
      expect(shards[0].shard_order).toBe(0)
      expect(mockClient.setCurrentSpace).toHaveBeenCalledWith('did:key:z')
    } finally {
      globalThis.fetch = originalFetch
      db.close()
    }
  })

  it('skips blobs that are already fetched (resume-friendly)', async () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)

    const hash = await sha256.digest(new TextEncoder().encode('already-done'))
    const cid = CID.create(1, 0x55, hash)
    const digestHex = Array.from(hash.bytes).map((b: number) => b.toString(16).padStart(2, '0')).join('')

    store.insertBlob({ digest: digestHex, size: 500, spaceDid: 'did:key:z', cid: cid.toString(), insertedAt: '' })
    store.markFetched(cid.toString(), 'did:key:z', true)

    const mockClient = {
      setCurrentSpace: vi.fn(),
      capability: {
        blob: {
          list: vi.fn().mockResolvedValue({
            results: [
              { blob: { digest: hash.bytes, size: 500 }, insertedAt: '' },
            ],
            cursor: undefined,
          }),
        },
      },
    }

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => {
      throw new Error('should not fetch already-processed blobs')
    }) as any

    const fetcher = new GatewayFetcher('http://gateway.test')

    try {
      await discoverShards(mockClient, [{ did: 'did:key:z', name: 'Test' }], store, fetcher)
      expect(globalThis.fetch).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
      db.close()
    }
  })
})

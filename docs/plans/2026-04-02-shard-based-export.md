# Shard-Based Export Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch individual ≤128MB blob shards from Storacha instead of full-DAG CARs, eliminating gateway timeouts on large uploads.

**Architecture:** New shard path runs alongside the existing full-DAG path. During discover, `blob.list()` enumerates blobs, index blobs are parsed to map uploads to shards, and the mapping is stored in SQLite. During export, uploads with shard records use the new path (fetch shards → merge blocks → single CAR); uploads without shard records fall back to the old path.

**Tech Stack:** `@storacha/client` (blob.list API), `@ipld/dag-cbor` (index parsing), `@ipld/car` (CAR read/write), `better-sqlite3`, `multiformats`, `undici`

**Spec:** `docs/2026-04-02-shard-based-export-design.md`

---

## Task 1: Add `@ipld/dag-cbor` dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the dependency**

```bash
cd /Users/danny/Private/sync-priv/filecoin/storacha-transition/storacha-export
npm install @ipld/dag-cbor
```

- [ ] **Step 2: Verify it resolves**

```bash
node -e "import('@ipld/dag-cbor').then(m => console.log('OK', Object.keys(m)))"
```

Expected: prints OK with exported keys including `decode`, `encode`, `code`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @ipld/dag-cbor for shard index parsing"
```

---

## Task 2: Add `blobs` and `shards` tables to the database

**Files:**
- Modify: `src/core/db.ts:7-41` (add new tables to the `db.exec` block)
- Test: `test/core/db.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/core/db.test.ts`:

```typescript
it('creates blobs and shards tables', () => {
  const db = createDatabase(TEST_DB)
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
  ).all().map((r: any) => r.name)

  expect(tables).toContain('blobs')
  expect(tables).toContain('shards')
  db.close()
})

it('blobs table enforces NOT NULL on cid', () => {
  const db = createDatabase(TEST_DB)
  expect(() => {
    db.prepare(
      "INSERT INTO blobs (digest, size, space_did, cid) VALUES ('abc', 100, 'did:key:z', 'bafyabc')"
    ).run()
  }).not.toThrow()

  expect(() => {
    db.prepare(
      "INSERT INTO blobs (digest, size, space_did) VALUES ('def', 100, 'did:key:z')"
    ).run()
  }).toThrow()
  db.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/core/db.test.ts
```

Expected: FAIL — `blobs` and `shards` not in table list

- [ ] **Step 3: Add tables to `src/core/db.ts`**

In the `db.exec()` template literal in `src/core/db.ts`, after the `spaces` table (before the closing backtick), add:

```sql
    CREATE TABLE IF NOT EXISTS blobs (
      digest TEXT NOT NULL,
      size INTEGER NOT NULL,
      space_did TEXT NOT NULL,
      cid TEXT NOT NULL,
      is_index INTEGER DEFAULT 0,
      fetched INTEGER DEFAULT 0,
      inserted_at TEXT,
      PRIMARY KEY (digest, space_did)
    );

    CREATE TABLE IF NOT EXISTS shards (
      upload_root TEXT NOT NULL,
      shard_cid TEXT NOT NULL,
      shard_size INTEGER,
      shard_order INTEGER NOT NULL,
      space_did TEXT NOT NULL,
      PRIMARY KEY (upload_root, shard_cid)
    );

    CREATE INDEX IF NOT EXISTS idx_shards_root ON shards(upload_root);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/core/db.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/db.ts test/core/db.test.ts
git commit -m "feat: add blobs and shards tables for shard-based export"
```

---

## Task 3: Create `src/core/shards.ts` — shard DB helpers and CID computation

This module provides functions to insert/query blobs and shards, and to compute CIDs from blob digests. Keeping this separate from the discover phase makes it testable without mocking the Storacha client.

**Files:**
- Create: `src/core/shards.ts`
- Test: `test/core/shards.test.ts`

- [ ] **Step 1: Write the failing test for CID computation**

Create `test/core/shards.test.ts`:

```typescript
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
    // blob.digest is the full multihash bytes (prefix + digest)
    const cid = cidFromBlobDigest(mh.bytes)
    expect(cid).not.toBeNull()
    expect(cid!.code).toBe(0x55) // raw codec
    expect(cid!.version).toBe(1)
    expect(cid!.toString()).toMatch(/^bafy/)
  })

  it('returns null for non-sha256 multihash', () => {
    // blake2b-256 prefix: 0xa0e40220 + 32 bytes
    const fakeDigest = new Uint8Array(34)
    fakeDigest[0] = 0xa0; fakeDigest[1] = 0xe4 // not a valid varint for sha256
    const cid = cidFromBlobDigest(fakeDigest)
    expect(cid).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/core/shards.test.ts
```

Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `cidFromBlobDigest` in `src/core/shards.ts`**

```typescript
import { CID } from 'multiformats/cid'
import { create as createDigest } from 'multiformats/hashes/digest'
import { varint } from 'multiformats'
import type Database from 'better-sqlite3'
import { log } from '../util/log.js'

/**
 * Compute a raw-codec CIDv1 from a blob's multihash digest bytes.
 * Returns null if the hash algorithm is not sha2-256 (0x12).
 */
export function cidFromBlobDigest(multihashBytes: Uint8Array): CID | null {
  // Parse the varint-encoded hash function code
  const [code, codeLen] = varint.decode(multihashBytes)
  if (code !== 0x12) {
    log('WARN', `Skipping blob with non-sha256 hash code: 0x${code.toString(16)}`)
    return null
  }
  // Parse the varint-encoded digest length
  const [digestLen, lenLen] = varint.decode(multihashBytes, codeLen)
  const digestBytes = multihashBytes.slice(codeLen + lenLen, codeLen + lenLen + digestLen)
  const mhDigest = createDigest(code, digestBytes)
  return CID.createV1(0x55, mhDigest) // raw codec
}
```

The `varint` export from `multiformats` provides `decode(buf, offset?)` returning `[value, bytesRead]`.

- [ ] **Step 4: Run test to verify CID computation passes**

```bash
npx vitest run test/core/shards.test.ts
```

Expected: PASS

- [ ] **Step 5: Write failing test for ShardStore (DB operations)**

Add to `test/core/shards.test.ts`:

```typescript
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
    store.insertBlob(blob) // duplicate — should not throw
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
```

- [ ] **Step 6: Implement ShardStore**

Add to `src/core/shards.ts`:

```typescript
export interface BlobInput {
  digest: string
  size: number
  spaceDid: string
  cid: string
  insertedAt: string
}

export interface ShardInput {
  uploadRoot: string
  shardCid: string
  shardSize: number | null
  shardOrder: number
  spaceDid: string
}

export interface ShardRow {
  upload_root: string
  shard_cid: string
  shard_size: number | null
  shard_order: number
  space_did: string
}

export interface BlobRow {
  digest: string
  size: number
  space_did: string
  cid: string
  is_index: number
  fetched: number
  inserted_at: string
}

export class ShardStore {
  private _insertBlob: Database.Statement
  private _insertShard: Database.Statement
  private _getCandidateIndexes: Database.Statement
  private _getShardsForUpload: Database.Statement
  private _markFetched: Database.Statement
  private _updateShardSizes: Database.Statement

  constructor(private db: Database.Database) {
    this._insertBlob = db.prepare(`
      INSERT OR IGNORE INTO blobs (digest, size, space_did, cid, inserted_at)
      VALUES (@digest, @size, @spaceDid, @cid, @insertedAt)
    `)
    this._insertShard = db.prepare(`
      INSERT OR IGNORE INTO shards (upload_root, shard_cid, shard_size, shard_order, space_did)
      VALUES (@uploadRoot, @shardCid, @shardSize, @shardOrder, @spaceDid)
    `)
    this._getCandidateIndexes = db.prepare(`
      SELECT * FROM blobs
      WHERE space_did = ? AND fetched = 0 AND size < 200000
      ORDER BY size ASC
    `)
    this._getShardsForUpload = db.prepare(`
      SELECT * FROM shards WHERE upload_root = ? ORDER BY shard_order
    `)
    this._markFetched = db.prepare(`
      UPDATE blobs SET fetched = 1, is_index = @isIndex
      WHERE cid = @cid AND space_did = @spaceDid
    `)
    this._updateShardSizes = db.prepare(`
      UPDATE shards SET shard_size = (
        SELECT blobs.size FROM blobs WHERE blobs.cid = shards.shard_cid
      )
      WHERE shard_size IS NULL
    `)
  }

  insertBlob(blob: BlobInput): void {
    this._insertBlob.run(blob)
  }

  insertShard(shard: ShardInput): void {
    this._insertShard.run(shard)
  }

  getUnfetchedCandidateIndexes(spaceDid: string): BlobRow[] {
    return this._getCandidateIndexes.all(spaceDid) as BlobRow[]
  }

  getShardsForUpload(uploadRoot: string): ShardRow[] {
    return this._getShardsForUpload.all(uploadRoot) as ShardRow[]
  }

  markFetched(cid: string, spaceDid: string, isIndex: boolean): void {
    this._markFetched.run({ cid, spaceDid, isIndex: isIndex ? 1 : 0 })
  }

  updateShardSizes(): void {
    this._updateShardSizes.run()
  }
}
```

- [ ] **Step 7: Run tests to verify everything passes**

```bash
npx vitest run test/core/shards.test.ts
```

Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/shards.ts test/core/shards.test.ts
git commit -m "feat: add ShardStore and CID computation for shard-based export"
```

---

## Task 4: Create `src/core/index-parser.ts` — parse Storacha index blobs

This module parses the dag-cbor index blobs to extract the upload root → shard CID mapping. Isolated from the network layer so it can be tested with synthetic data.

**Files:**
- Create: `src/core/index-parser.ts`
- Test: `test/core/index-parser.test.ts`

- [ ] **Step 1: Write failing test for index parsing**

Create `test/core/index-parser.test.ts`:

```typescript
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
    // Use real-looking CIDs (raw codec, sha256)
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
    // Build a plain CAR with a raw block (not dag-cbor)
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/core/index-parser.test.ts
```

Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `parseIndexBlob`**

Create `src/core/index-parser.ts`:

```typescript
import { CarBlockIterator } from '@ipld/car'
import * as dagCBOR from '@ipld/dag-cbor'

const DAG_CBOR_CODEC = 0x71

export interface IndexBlobResult {
  contentRoot: string
  shardCids: string[]
}

/**
 * Attempt to parse raw CAR bytes as a Storacha index blob.
 * Returns the content root and shard CID list if the CAR contains
 * a dag-cbor block with the `index/sharded/dag@0.1` key.
 * Returns null if this is not an index blob or parsing fails.
 */
export async function parseIndexBlob(carBytes: Uint8Array): Promise<IndexBlobResult | null> {
  try {
    const iterator = await CarBlockIterator.fromIterable(
      (async function* () { yield carBytes })()
    )

    for await (const { cid, bytes } of iterator) {
      if (cid.code !== DAG_CBOR_CODEC) continue

      const decoded = dagCBOR.decode(bytes) as Record<string, any>
      const index = decoded['index/sharded/dag@0.1']
      if (!index) continue

      const contentRoot = String(index.content)
      const shardCids = (index.shards as any[]).map(s => String(s))

      if (!contentRoot || shardCids.length === 0) continue

      return { contentRoot, shardCids }
    }

    return null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/core/index-parser.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/index-parser.ts test/core/index-parser.test.ts
git commit -m "feat: add index blob parser for shard discovery"
```

---

## Task 5: Add `fetchShard` method to `GatewayFetcher`

**Files:**
- Modify: `src/core/fetcher.ts:70-183`
- Test: `test/core/fetcher.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/core/fetcher.test.ts`, inside the existing `describe('GatewayFetcher')`:

```typescript
it('fetches a shard and returns a Response', async () => {
  // Set up server to handle ?format=raw
  const leaf = await makeRawBlock('shard-data')
  const shardCar = await buildCarBytes([leaf], [leaf])

  const rawServer = http.createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    if (url.searchParams.get('format') === 'raw') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
      res.end(shardCar)
    } else {
      res.writeHead(404); res.end()
    }
  })
  await new Promise<void>(resolve => rawServer.listen(0, resolve))
  const rawUrl = `http://127.0.0.1:${(rawServer.address() as any).port}`

  try {
    const fetcher = new GatewayFetcher(rawUrl)
    const res = await fetcher.fetchShard(leaf.cid.toString())
    expect(res.ok).toBe(true)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(bytes.length).toBe(shardCar.length)
  } finally {
    await new Promise<void>(resolve => rawServer.close(() => resolve()))
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/core/fetcher.test.ts
```

Expected: FAIL — `fetchShard` is not a function

- [ ] **Step 3: Add `fetchShard` method to GatewayFetcher**

Add to the `GatewayFetcher` class in `src/core/fetcher.ts`, after `fetchBlock`:

```typescript
  /**
   * Fetch a shard blob by CID. Returns the raw HTTP Response.
   * The response body is the raw blob content (a valid CAR file for data shards).
   * Uses carDispatcher since shards can be up to 128MB.
   */
  async fetchShard(cidStr: string, maxRetries = 3): Promise<Response> {
    const url = `${this.gatewayUrl.replace(/\/$/, '')}/ipfs/${cidStr}?format=raw`

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      await this.rateGate.wait()

      const res = await fetch(url, { dispatcher: carDispatcher } as any)

      if (res.status === 429) {
        await res.body?.cancel()
        this.rateGate.backoff(res.headers.get('retry-after'))
        continue
      }

      if (res.status >= 500) {
        await res.body?.cancel()
        const delay = Math.min(2000 * Math.pow(2, attempt), 30000)
        log('RETRY', `Shard ${cidStr.slice(0, 20)}... HTTP ${res.status}, waiting ${Math.round(delay / 1000)}s`)
        await new Promise(r => setTimeout(r, delay))
        continue
      }

      if (!res.ok) {
        await res.body?.cancel()
        throw new Error(`Shard fetch failed: HTTP ${res.status} ${res.statusText}`)
      }

      return res
    }
    throw new Error(`Shard fetch failed after ${maxRetries} attempts: ${cidStr}`)
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/core/fetcher.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/fetcher.ts test/core/fetcher.test.ts
git commit -m "feat: add fetchShard method to GatewayFetcher"
```

---

## Task 6: Create `discoverShards` function in discover phase

**Files:**
- Modify: `src/phases/discover.ts`
- Test: `test/phases/discover-shards.test.ts`

This is the orchestrator that calls blob.list(), identifies indexes, parses them, and populates the shards table. It depends on ShardStore, parseIndexBlob, and GatewayFetcher.

- [ ] **Step 1: Write failing test**

Create `test/phases/discover-shards.test.ts`:

```typescript
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

/** Build a synthetic index blob CAR */
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

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

describe('discoverShards', () => {
  it('enumerates blobs, parses indexes, and populates shards table', async () => {
    const db = createDatabase(TEST_DB)
    const store = new ShardStore(db)

    // Create CIDs for the upload root and shard
    const rootHash = await sha256.digest(new TextEncoder().encode('upload-root'))
    const uploadRoot = CID.create(1, 0x70, rootHash)
    const shardHash = await sha256.digest(new TextEncoder().encode('data-shard'))
    const shardCid = CID.create(1, 0x55, shardHash)

    // Build the index blob CAR
    const indexCarBytes = await buildIndexBlob(uploadRoot.toString(), [shardCid.toString()])
    const indexBlobHash = await sha256.digest(indexCarBytes)
    const indexBlobCid = CID.create(1, 0x55, indexBlobHash)

    // Mock client with blob.list() returning two blobs: index + data shard
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

    // Mock fetcher — returns the index blob CAR when fetched
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

    // Pre-insert as already fetched
    store.insertBlob({ digest: toHex(hash.bytes), size: 500, spaceDid: 'did:key:z', cid: cid.toString(), insertedAt: '' })
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/phases/discover-shards.test.ts
```

Expected: FAIL — `discoverShards` is not exported from discover.ts

- [ ] **Step 3: Implement `discoverShards`**

Add to `src/phases/discover.ts`:

```typescript
import { cidFromBlobDigest, ShardStore } from '../core/shards.js'
import { parseIndexBlob } from '../core/index-parser.js'
import type { GatewayFetcher } from '../core/fetcher.js'

/**
 * Enumerate blobs via blob.list(), identify and parse index blobs,
 * and populate the shards table with upload→shard mappings.
 */
export async function discoverShards(
  client: any,
  spaces: Array<{ did: string; name: string }>,
  store: ShardStore,
  fetcher: GatewayFetcher,
): Promise<void> {
  for (const space of spaces) {
    log('INFO', `Discovering shards for ${space.name}...`)
    client.setCurrentSpace(space.did)
    let cursor: string | undefined
    let blobCount = 0

    // Step 1: enumerate all blobs
    do {
      const result = await client.capability.blob.list({ size: 1000, cursor })
      for (const entry of result.results) {
        const digestHex = Array.from(entry.blob.digest as Uint8Array)
          .map((b: number) => b.toString(16).padStart(2, '0')).join('')
        const cid = cidFromBlobDigest(entry.blob.digest)
        if (!cid) continue

        store.insertBlob({
          digest: digestHex,
          size: entry.blob.size,
          spaceDid: space.did,
          cid: cid.toString(),
          insertedAt: entry.insertedAt || '',
        })
        blobCount++
      }
      cursor = result.cursor
    } while (cursor)

    log('INFO', `  ${space.name}: ${blobCount} blobs`)

    // Step 2: fetch and parse candidate index blobs
    const candidates = store.getUnfetchedCandidateIndexes(space.did)
    let indexCount = 0
    let multiShardCount = 0

    for (const blob of candidates) {
      try {
        const res = await fetcher.fetchShard(blob.cid)
        const bytes = new Uint8Array(await res.arrayBuffer())
        const result = await parseIndexBlob(bytes)

        if (result) {
          store.markFetched(blob.cid, space.did, true)
          for (let i = 0; i < result.shardCids.length; i++) {
            store.insertShard({
              uploadRoot: result.contentRoot,
              shardCid: result.shardCids[i],
              shardSize: null,
              shardOrder: i,
              spaceDid: space.did,
            })
          }
          indexCount++
          if (result.shardCids.length > 1) multiShardCount++
        } else {
          store.markFetched(blob.cid, space.did, false)
        }
      } catch (err: any) {
        log('WARN', `  Failed to fetch/parse blob ${blob.cid.slice(0, 20)}...: ${err.message}`)
        store.markFetched(blob.cid, space.did, false)
      }
    }

    // Step 3: fill in shard sizes from blobs table
    store.updateShardSizes()

    log('INFO', `  ${space.name}: ${indexCount} indexes parsed, ${multiShardCount} multi-shard uploads`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/phases/discover-shards.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/phases/discover.ts test/phases/discover-shards.test.ts
git commit -m "feat: add discoverShards to enumerate blobs and parse indexes"
```

---

## Task 7: Create `exportUploadViaShards` in the pipeline

**Files:**
- Create: `src/core/shard-pipeline.ts`
- Test: `test/core/shard-pipeline.test.ts`

- [ ] **Step 1: Write failing test**

Create `test/core/shard-pipeline.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { exportUploadViaShards } from '../../src/core/shard-pipeline.js'
import { UploadQueue } from '../../src/core/queue.js'
import { ShardStore } from '../../src/core/shards.js'
import { createDatabase } from '../../src/core/db.js'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from './blocks.test.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import { CarBlockIterator } from '@ipld/car'
import type { ExportBackend } from '../../src/backends/interface.js'
import { GatewayFetcher } from '../../src/core/fetcher.js'
import type { Block } from '../../src/core/blocks.js'

const TEST_DB = '/tmp/storacha-v2-shard-pipeline-test.db'

/** Backend that collects blocks from a BlockStream */
class BlockCollectorBackend implements ExportBackend {
  name = 'collector'
  blocks = new Map<string, Uint8Array>()
  rootCids = new Set<string>()

  async importCar(rootCid: string, stream: any): Promise<void> {
    this.rootCids.add(rootCid)
    for await (const block of stream) {
      if (block.cid) {
        this.blocks.set(block.cid.toString(), block.bytes)
      }
    }
  }

  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    return this.rootCids.has(rootCid) && this.blocks.size > 0
      ? { valid: true }
      : { valid: false, error: 'not imported' }
  }
}

describe('exportUploadViaShards', () => {
  let db: Database.Database
  let queue: UploadQueue
  let shardStore: ShardStore

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    queue = new UploadQueue(db)
    shardStore = new ShardStore(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('fetches shards in order and passes combined block stream to backend', async () => {
    // Build two shards: shard1 has root+leaf1, shard2 has leaf2
    const leaf1 = await makeRawBlock('leaf-one')
    const leaf2 = await makeRawBlock('leaf-two')
    const root = await makeDagPBNode([leaf1, leaf2])
    const rootCid = root.cid.toString()

    const shard1Car = await buildCarBytes([root, leaf1], [root])
    const shard2Car = await buildCarBytes([leaf2], []) // rootless intermediate shard

    // Pre-populate shard records
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard1', shardSize: shard1Car.length, shardOrder: 0, spaceDid: 'did:key:z' })
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard2', shardSize: shard2Car.length, shardOrder: 1, spaceDid: 'did:key:z' })

    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'Test', backend: 'collector' })

    // Mock fetch to return shard CARs
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.includes('bafyshard1')) {
        return new Response(shard1Car, { status: 200 })
      }
      if (url.pathname.includes('bafyshard2')) {
        return new Response(shard2Car, { status: 200 })
      }
      return new Response('not found', { status: 404 })
    }) as any

    const backend = new BlockCollectorBackend()
    const fetcher = new GatewayFetcher('http://gateway.test')

    try {
      await exportUploadViaShards({
        rootCid,
        backend,
        queue,
        shardStore,
        fetcher,
      })

      expect(queue.getStatus(rootCid, 'collector')).toBe('complete')
      expect(backend.blocks.size).toBe(3) // root + leaf1 + leaf2
      expect(backend.blocks.has(root.cid.toString())).toBe(true)
      expect(backend.blocks.has(leaf1.cid.toString())).toBe(true)
      expect(backend.blocks.has(leaf2.cid.toString())).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('marks upload as error when verification fails', async () => {
    const leaf = await makeRawBlock('only-leaf')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()
    // Shard with only the leaf — root missing, verifyDag will fail
    const shardCar = await buildCarBytes([leaf], [])

    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard', shardSize: shardCar.length, shardOrder: 0, spaceDid: 'did:key:z' })
    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'Test', backend: 'failverify' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => new Response(shardCar, { status: 200 })) as any

    const backend: ExportBackend = {
      name: 'failverify',
      async importCar(_rootCid: string, stream: any) { for await (const _ of stream) {} },
      async verifyDag() { return { valid: false, error: 'root missing' } },
    }

    try {
      await exportUploadViaShards({
        rootCid,
        backend,
        queue,
        shardStore,
        fetcher: new GatewayFetcher('http://gateway.test'),
      })

      expect(queue.getStatus(rootCid, 'failverify')).toBe('error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('skips download when verifyDag already confirms completeness', async () => {
    const rootCid = 'bafyalreadydone'
    shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard', shardSize: 100, shardOrder: 0, spaceDid: 'did:key:z' })
    queue.add({ rootCid, spaceDid: 'did:key:z', spaceName: 'Test', backend: 'done' })

    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async () => { throw new Error('should not fetch') }) as any

    const backend: ExportBackend = {
      name: 'done',
      async importCar() { throw new Error('should not import') },
      async verifyDag() { return { valid: true } },
    }

    try {
      await exportUploadViaShards({
        rootCid,
        backend,
        queue,
        shardStore,
        fetcher: new GatewayFetcher('http://gateway.test'),
      })

      expect(queue.getStatus(rootCid, 'done')).toBe('complete')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/core/shard-pipeline.test.ts
```

Expected: FAIL — module does not exist

- [ ] **Step 3: Implement `exportUploadViaShards`**

Create `src/core/shard-pipeline.ts`:

```typescript
import { CarBlockIterator } from '@ipld/car'
import { Readable } from 'node:stream'
import type { GatewayFetcher } from './fetcher.js'
import type { ShardStore } from './shards.js'
import type { UploadQueue } from './queue.js'
import type { ExportBackend } from '../backends/interface.js'
import type { Block } from './blocks.js'
import { log } from '../util/log.js'

export interface ShardExportOptions {
  rootCid: string
  backend: ExportBackend
  queue: UploadQueue
  shardStore: ShardStore
  fetcher: GatewayFetcher
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

/**
 * Export an upload by fetching its individual shards and streaming
 * all blocks into the backend as a single combined BlockStream.
 */
export async function exportUploadViaShards(options: ShardExportOptions): Promise<void> {
  const { rootCid, backend, queue, shardStore, fetcher, onProgress } = options
  const tag = `[${rootCid.slice(0, 24)}...]`

  // Check if already complete
  const initialCheck = await backend.verifyDag(rootCid)
  if (initialCheck.valid) {
    queue.markComplete(rootCid, backend.name, 0)
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    log('INFO', `${tag} Already complete in ${backend.name}`)
    return
  }

  const shards = shardStore.getShardsForUpload(rootCid)
  if (shards.length === 0) {
    queue.markError(rootCid, backend.name, 'No shards found')
    return
  }

  queue.setStatus(rootCid, backend.name, 'downloading')
  onProgress?.({ type: 'downloading', rootCid })
  log('INFO', `${tag} Fetching ${shards.length} shard(s)`)

  let totalBytes = 0

  // Create an async generator that yields blocks from all shards in order
  async function* shardBlockStream(): AsyncIterable<Block> {
    for (const shard of shards) {
      const res = await fetcher.fetchShard(shard.shard_cid)
      const bytes = new Uint8Array(await res.arrayBuffer())
      totalBytes += bytes.length

      const iterator = await CarBlockIterator.fromIterable(
        (async function* () { yield bytes })()
      )

      for await (const block of iterator) {
        yield block
      }

      onProgress?.({ type: 'progress', rootCid, bytes: totalBytes })
      log('INFO', `${tag} Shard ${shard.shard_order + 1}/${shards.length} done (${bytes.length} bytes)`)
    }
  }

  try {
    await backend.importCar(rootCid, shardBlockStream())

    const verifyResult = await backend.verifyDag(rootCid)
    if (verifyResult.valid) {
      queue.markComplete(rootCid, backend.name, totalBytes)
      onProgress?.({ type: 'done', rootCid, bytes: totalBytes })
      log('INFO', `${tag} Complete via shards`)
      return
    }

    queue.markError(rootCid, backend.name, verifyResult.error || 'DAG verification failed after shard import')
    onProgress?.({ type: 'error', rootCid, error: verifyResult.error })
  } catch (err: any) {
    queue.markError(rootCid, backend.name, err.message)
    onProgress?.({ type: 'error', rootCid, error: err.message })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/core/shard-pipeline.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/shard-pipeline.ts test/core/shard-pipeline.test.ts
git commit -m "feat: add exportUploadViaShards for shard-based export"
```

---

## Task 8: Wire shard path into the export phase

Modify `phases/export.ts` to check for shard records and dispatch to `exportUploadViaShards` when available.

**Files:**
- Modify: `src/phases/export.ts:1-60`
- Test: `test/phases/export.test.ts`

- [ ] **Step 1: Write failing test**

Add to `test/phases/export.test.ts`:

```typescript
import { ShardStore } from '../../src/core/shards.js'

it('uses shard path when upload has shard records', async () => {
  const leaf = await makeRawBlock('shard-leaf')
  const root = await makeDagPBNode([leaf])
  const rootCid = root.cid.toString()
  const shardCar = await buildCarBytes([root, leaf], [root])

  const originalFetch = globalThis.fetch
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input))
    if (url.pathname.includes('bafyshard-export')) {
      return new Response(shardCar, { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as any

  const backend = new MemoryBackend()
  const shardStore = new ShardStore(db)

  // Insert shard record — this should trigger the shard path
  shardStore.insertShard({ uploadRoot: rootCid, shardCid: 'bafyshard-export', shardSize: shardCar.length, shardOrder: 0, spaceDid: 'did:key:test' })

  queue.add({ rootCid, spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })

  try {
    await runExport({
      queue,
      manifest,
      backends: [backend],
      gatewayUrl: 'http://gateway.test',
      concurrency: 1,
      spaceNames: ['TestSpace'],
      shardStore,
    })

    expect(queue.getStatus(rootCid, 'memory')).toBe('complete')
    expect(backend.blocks.has(root.cid.toString())).toBe(true)
    expect(backend.blocks.has(leaf.cid.toString())).toBe(true)
  } finally {
    globalThis.fetch = originalFetch
  }
})
```

Note: the `MemoryBackend` in `test/phases/export.test.ts` currently only handles raw byte streams via `CarBlockIterator`. For the shard path it will receive a `BlockStream` (objects with `{ cid, bytes }`). Update `MemoryBackend.importCar` to handle both:

```typescript
async importCar(rootCid: string, stream: any) {
  const chunks: any[] = []
  for await (const chunk of stream) chunks.push(chunk)
  if (chunks.length > 0 && chunks[0].cid) {
    // BlockStream
    for (const block of chunks) this.blocks.set(block.cid.toString(), block.bytes)
  } else {
    // Raw byte stream
    const carBytes = Buffer.concat(chunks)
    const iterator = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(carBytes) })()
    )
    for await (const { cid, bytes } of iterator) this.blocks.set(cid.toString(), bytes)
  }
  this.pinned.add(rootCid)
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/phases/export.test.ts
```

Expected: FAIL — `shardStore` is not a valid option

- [ ] **Step 3: Modify `src/phases/export.ts`**

Add `shardStore` as an optional field on `ExportOptions`:

```typescript
import { ShardStore } from '../core/shards.js'
import { exportUploadViaShards } from '../core/shard-pipeline.js'
```

Add to `ExportOptions` interface:

```typescript
  shardStore?: ShardStore
```

In the `worker()` function, before calling `exportUpload`, check for shards:

```typescript
    async function worker() {
      while (idx < pending.length) {
        const upload = pending[idx++]
        onProgress?.({ type: 'downloading', rootCid: upload.root_cid, spaceName: upload.space_name })

        // Use shard path if shards are available for this upload
        if (shardStore && shardStore.getShardsForUpload(upload.root_cid).length > 0) {
          await exportUploadViaShards({
            rootCid: upload.root_cid,
            backend,
            queue,
            shardStore,
            fetcher,
            onProgress: onProgress && ((info) => onProgress({ ...info, spaceName: upload.space_name })),
          })
        } else {
          await exportUpload({
            rootCid: upload.root_cid,
            backend,
            queue,
            manifest,
            fetcher,
            gatewayUrl,
            onProgress: onProgress && ((info) => onProgress({ ...info, spaceName: upload.space_name })),
          })
        }
      }
    }
```

Destructure `shardStore` from options at the top of `runExport`:

```typescript
const { queue, manifest, backends, gatewayUrl, concurrency = 1, spaceNames, shardStore, createFetcher = (url) => new GatewayFetcher(url), onProgress } = options
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/phases/export.test.ts
```

Expected: PASS (all existing tests should still pass too, since `shardStore` is optional)

- [ ] **Step 5: Commit**

```bash
git add src/phases/export.ts test/phases/export.test.ts
git commit -m "feat: wire shard export path into runExport"
```

---

## Task 9: Wire `discoverShards` and `ShardStore` into CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add imports to `src/cli.ts`**

Add after existing imports:

```typescript
import { discoverShards } from './phases/discover.js'
import { ShardStore } from './core/shards.js'
import { GatewayFetcher } from './core/fetcher.js'
```

- [ ] **Step 2: Create ShardStore after DB setup**

After `const manifest = new BlockManifest(db)` (around line 316), add:

```typescript
    const shardStore = new ShardStore(db)
```

- [ ] **Step 3: Add shard discovery between enumeration and export**

After the enumeration block (after `statusMessage = \`Ready — ...\`` around line 359), add:

```typescript
    // --- Shard discovery ---
    statusMessage = 'Discovering blob shards...'
    addLogLine('Discovering blob shards...')
    const fetcher = new GatewayFetcher(opts.gateway)
    await discoverShards(client, selectedSpaces, shardStore, fetcher)
    addLogLine('Shard discovery complete')
```

- [ ] **Step 4: Pass shardStore and shared fetcher to runExport**

In the `runExport` call (around line 375), add `shardStore` and `createFetcher`
so that the export phase shares the same `GatewayFetcher` (and its rate-limit gate)
with shard discovery:

```typescript
    await runExport({
      queue,
      manifest,
      backends,
      gatewayUrl: opts.gateway,
      concurrency: opts.concurrency,
      spaceNames: selectedSpaces.map((s) => s.name),
      shardStore,
      createFetcher: () => fetcher, // reuse the fetcher created for shard discovery
      onProgress,
    })
```

- [ ] **Step 5: Run all tests to verify nothing is broken**

```bash
npx vitest run
```

Expected: PASS on all existing and new tests

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: wire shard discovery and shard export into CLI"
```

---

## Task 10: End-to-end test with local backend

Verify the full flow: shard discovery → shard export → single CAR file with correct root.

**Files:**
- Modify: `test/e2e.test.ts` (or create `test/e2e-shards.test.ts`)

- [ ] **Step 1: Write the e2e test**

Create `test/e2e-shards.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the e2e test**

```bash
npx vitest run test/e2e-shards.test.ts
```

Expected: PASS

- [ ] **Step 3: Run the full test suite**

```bash
npx vitest run
```

Expected: ALL PASS — existing tests unaffected, new tests green

- [ ] **Step 4: Commit**

```bash
git add test/e2e-shards.test.ts
git commit -m "test: end-to-end test for shard-based export with local backend"
```

---

## Task 11: Run against live data

This is a manual validation step — run the tool against the actual Storacha spaces with the pending uploads.

- [ ] **Step 1: Run with existing DB to pick up pending uploads**

```bash
node bin/storacha-export.js --backend local --output ./export --gateway https://dag.w3s.link --db storacha-export.db
```

Observe:
- Shard discovery logs ("N blobs, M indexes parsed")
- Shard-based downloads for pending uploads
- Single CAR files produced with correct roots

- [ ] **Step 2: Verify the exported CARs**

```bash
node bin/storacha-export.js --verify --backend local --output ./export --db storacha-export.db
```

Expected: all previously-pending uploads now verify as complete

- [ ] **Step 3: Commit any adjustments discovered during live testing**

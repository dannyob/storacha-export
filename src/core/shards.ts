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
  const [code, codeLen] = varint.decode(multihashBytes)
  if (code !== 0x12) {
    log('INFO', `Skipping blob with non-sha256 hash code: 0x${code.toString(16)}`)
    return null
  }
  const [digestLen, lenLen] = varint.decode(multihashBytes, codeLen)
  const digestBytes = multihashBytes.slice(codeLen + lenLen, codeLen + lenLen + digestLen)
  const mhDigest = createDigest(code, digestBytes)
  return CID.createV1(0x55, mhDigest)
}

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

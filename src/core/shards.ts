import type Database from 'better-sqlite3'

export interface ShardInput {
  shardCid: string
  locationUrl: string | null
  size: number | null
  order: number
}

export interface ShardRow {
  upload_root: string
  shard_cid: string
  location_url: string | null
  shard_size: number | null
  shard_order: number
  space_did: string
  resolved: number
}

export class ShardStore {
  private _insert: Database.Statement
  private _getForUpload: Database.Statement
  private _hasResolved: Database.Statement

  constructor(private db: Database.Database) {
    this._insert = db.prepare(`
      INSERT OR IGNORE INTO shards (upload_root, shard_cid, location_url, shard_size, shard_order, space_did, resolved)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `)
    this._getForUpload = db.prepare(
      `SELECT * FROM shards WHERE upload_root = ? AND location_url IS NOT NULL ORDER BY shard_order`
    )
    this._hasResolved = db.prepare(
      `SELECT 1 FROM shards WHERE upload_root = ? AND location_url IS NOT NULL LIMIT 1`
    )
  }

  insertShards(uploadRoot: string, spaceDid: string, shards: ShardInput[]): void {
    const tx = this.db.transaction(() => {
      for (const s of shards) {
        this._insert.run(uploadRoot, s.shardCid, s.locationUrl, s.size, s.order, spaceDid)
      }
    })
    tx()
  }

  getShardsForUpload(uploadRoot: string): ShardRow[] {
    return this._getForUpload.all(uploadRoot) as ShardRow[]
  }

  hasResolvedShards(uploadRoot: string): boolean {
    return this._hasResolved.get(uploadRoot) !== undefined
  }
}

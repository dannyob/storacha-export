import type Database from 'better-sqlite3'

export interface ManifestRow {
  root_cid: string
  block_cid: string
  codec: number
  seen: number
  linked_by: string | null
}

export class BlockManifest {
  private _markSeen: Database.Statement
  private _addLink: Database.Statement
  private _isSeen: Database.Statement
  private _getMissing: Database.Statement
  private _getMissingDagPB: Database.Statement
  private _getProgress: Database.Statement
  private _clear: Database.Statement

  constructor(private db: Database.Database) {
    this._markSeen = db.prepare(`
      INSERT INTO blocks (root_cid, block_cid, codec, seen)
      VALUES (@rootCid, @blockCid, @codec, 1)
      ON CONFLICT(root_cid, block_cid) DO UPDATE SET seen = 1
    `)

    this._addLink = db.prepare(`
      INSERT OR IGNORE INTO blocks (root_cid, block_cid, codec, seen, linked_by)
      VALUES (@rootCid, @blockCid, @codec, 0, @linkedBy)
    `)

    this._isSeen = db.prepare(
      `SELECT seen FROM blocks WHERE root_cid = @rootCid AND block_cid = @blockCid`
    )

    this._getMissing = db.prepare(
      `SELECT * FROM blocks WHERE root_cid = @rootCid AND seen = 0`
    )

    this._getMissingDagPB = db.prepare(
      `SELECT * FROM blocks WHERE root_cid = @rootCid AND seen = 0 AND codec = 0x70`
    )

    this._getProgress = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN seen = 1 THEN 1 ELSE 0 END) as seen,
        SUM(CASE WHEN seen = 0 THEN 1 ELSE 0 END) as missing
      FROM blocks WHERE root_cid = @rootCid
    `)

    this._clear = db.prepare(`DELETE FROM blocks WHERE root_cid = @rootCid`)
  }

  markSeen(rootCid: string, blockCid: string, codec: number): void {
    this._markSeen.run({ rootCid, blockCid, codec })
  }

  addLink(rootCid: string, blockCid: string, codec: number, linkedBy: string): void {
    this._addLink.run({ rootCid, blockCid, codec, linkedBy })
  }

  isSeen(rootCid: string, blockCid: string): boolean {
    const row = this._isSeen.get({ rootCid, blockCid }) as { seen: number } | undefined
    return row?.seen === 1
  }

  getMissing(rootCid: string): ManifestRow[] {
    return this._getMissing.all({ rootCid }) as ManifestRow[]
  }

  getMissingDagPB(rootCid: string): ManifestRow[] {
    return this._getMissingDagPB.all({ rootCid }) as ManifestRow[]
  }

  isRepairable(rootCid: string): boolean {
    const missing = this.getMissing(rootCid)
    if (missing.length === 0) return false
    return this.getMissingDagPB(rootCid).length === 0
  }

  getProgress(rootCid: string): { total: number; seen: number; missing: number } {
    return this._getProgress.get({ rootCid }) as { total: number; seen: number; missing: number }
  }

  clear(rootCid: string): void {
    this._clear.run({ rootCid })
  }
}

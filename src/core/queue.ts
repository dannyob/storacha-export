import type Database from 'better-sqlite3'

export type UploadStatus = 'pending' | 'downloading' | 'partial' | 'repairing' | 'complete' | 'error'

export interface UploadRow {
  root_cid: string
  space_did: string
  space_name: string
  backend: string
  status: UploadStatus
  error_msg: string | null
  attempt_count: number
  bytes_transferred: number
  created_at: string
  updated_at: string
}

export interface UploadInput {
  rootCid: string
  spaceDid: string
  spaceName: string
  backend: string
}

export class UploadQueue {
  private _add: Database.Statement
  private _setStatus: Database.Statement
  private _markComplete: Database.Statement
  private _markError: Database.Statement
  private _get: Database.Statement
  private _getPending: Database.Statement
  private _resetForRetry: Database.Statement
  private _requeueCompleteWithMissing: Database.Statement
  private _getStats: Database.Statement
  private _getComplete: Database.Statement
  private _getActiveJobs: Database.Statement
  private _getRecentDone: Database.Statement
  private _getRecentErrors: Database.Statement
  private _addBatch: Database.Transaction

  constructor(private db: Database.Database) {
    this._add = db.prepare(`
      INSERT OR IGNORE INTO uploads (root_cid, space_did, space_name, backend)
      VALUES (@rootCid, @spaceDid, @spaceName, @backend)
    `)

    this._setStatus = db.prepare(`
      UPDATE uploads SET status = @status, updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)

    this._markComplete = db.prepare(`
      UPDATE uploads SET status = 'complete', bytes_transferred = @bytes, updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)

    this._markError = db.prepare(`
      UPDATE uploads SET status = 'error', error_msg = @errorMsg,
        attempt_count = attempt_count + 1, updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)

    this._get = db.prepare(`SELECT * FROM uploads WHERE root_cid = @rootCid AND backend = @backend`)

    this._getPending = db.prepare(`SELECT * FROM uploads WHERE backend = @backend AND status = 'pending'`)

    this._resetForRetry = db.prepare(`
      UPDATE uploads SET status = 'pending', error_msg = NULL, updated_at = datetime('now')
      WHERE status IN ('error', 'partial', 'downloading', 'repairing')
    `)

    this._requeueCompleteWithMissing = db.prepare(`
      UPDATE uploads
      SET status = 'pending', error_msg = NULL, updated_at = datetime('now')
      WHERE backend = @backend
        AND status = 'complete'
        AND EXISTS (
          SELECT 1
          FROM blocks
          WHERE blocks.root_cid = uploads.root_cid
            AND blocks.seen = 0
        )
    `)

    this._getStats = db.prepare(`
      SELECT
        COUNT(DISTINCT root_cid) as total,
        COALESCE((SELECT COUNT(DISTINCT root_cid) FROM uploads u2
          WHERE NOT EXISTS (SELECT 1 FROM uploads u3 WHERE u3.root_cid = u2.root_cid AND u3.status != 'complete')), 0) as complete,
        COALESCE((SELECT COUNT(DISTINCT root_cid) FROM uploads WHERE status = 'error'), 0) as error,
        COALESCE((SELECT COUNT(DISTINCT root_cid) FROM uploads WHERE status = 'pending'
          AND root_cid NOT IN (SELECT root_cid FROM uploads WHERE status IN ('downloading', 'repairing', 'error'))), 0) as pending,
        COALESCE((SELECT COUNT(DISTINCT root_cid) FROM uploads WHERE status = 'downloading'), 0) as downloading,
        COALESCE((SELECT COUNT(DISTINCT root_cid) FROM uploads WHERE status = 'partial'), 0) as partial,
        COALESCE((SELECT COUNT(DISTINCT root_cid) FROM uploads WHERE status = 'repairing'), 0) as repairing,
        COALESCE(SUM(bytes_transferred), 0) as total_bytes
      FROM uploads
    `)

    this._getComplete = db.prepare(`SELECT * FROM uploads WHERE backend = @backend AND status = 'complete'`)

    this._getActiveJobs = db.prepare(
      "SELECT space_name, root_cid, status FROM uploads WHERE status IN ('downloading', 'repairing') ORDER BY updated_at DESC LIMIT ?"
    )

    this._getRecentDone = db.prepare(
      "SELECT space_name, root_cid FROM uploads WHERE status = 'complete' AND updated_at >= @since ORDER BY updated_at DESC LIMIT @limit"
    )

    this._getRecentErrors = db.prepare(
      "SELECT space_name, root_cid, error_msg FROM uploads WHERE status = 'error' AND updated_at >= @since ORDER BY updated_at DESC LIMIT @limit"
    )

    this._addBatch = db.transaction((uploads: UploadInput[]) => {
      for (const u of uploads) this._add.run(u)
    })
  }

  add(upload: UploadInput): void {
    this._add.run(upload)
  }

  addBatch(uploads: UploadInput[]): void {
    this._addBatch(uploads)
  }

  get(rootCid: string, backend: string): UploadRow | undefined {
    return this._get.get({ rootCid, backend }) as UploadRow | undefined
  }

  getStatus(rootCid: string, backend: string): UploadStatus | undefined {
    return this.get(rootCid, backend)?.status
  }

  setStatus(rootCid: string, backend: string, status: UploadStatus): void {
    this._setStatus.run({ rootCid, backend, status })
  }

  markComplete(rootCid: string, backend: string, bytes: number): void {
    this._markComplete.run({ rootCid, backend, bytes })
  }

  markError(rootCid: string, backend: string, errorMsg: string): void {
    this._markError.run({ rootCid, backend, errorMsg })
  }

  getComplete(backend: string): UploadRow[] {
    return this._getComplete.all({ backend }) as UploadRow[]
  }

  getPending(backend: string): UploadRow[] {
    return this._getPending.all({ backend }) as UploadRow[]
  }

  getPendingForSpaces(backend: string, spaceNames: string[]): UploadRow[] {
    const placeholders = spaceNames.map(() => '?').join(',')
    return this.db.prepare(
      `SELECT * FROM uploads WHERE backend = ? AND status = 'pending' AND space_name IN (${placeholders})`
    ).all(backend, ...spaceNames) as UploadRow[]
  }

  resetForRetry(): number {
    return this._resetForRetry.run().changes
  }

  requeueCompleteWithMissing(backend: string): number {
    return this._requeueCompleteWithMissing.run({ backend }).changes
  }

  getStats() {
    return this._getStats.get() as {
      total: number; complete: number; error: number; pending: number;
      downloading: number; partial: number; repairing: number; total_bytes: number
    }
  }

  getStatsBySpace(spaceNames: string[]): Array<{
    space_name: string; done: number; errors: number; pending: number;
    active: number; total: number; bytes: number
  }> {
    const placeholders = spaceNames.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT space_name,
        COUNT(DISTINCT CASE WHEN root_cid NOT IN (
          SELECT root_cid FROM uploads u2 WHERE u2.space_name = uploads.space_name AND u2.status != 'complete'
        ) THEN root_cid END) as done,
        COUNT(DISTINCT CASE WHEN status = 'error' THEN root_cid END) as errors,
        COUNT(DISTINCT CASE WHEN status = 'pending' THEN root_cid END) as pending,
        COUNT(DISTINCT CASE WHEN status IN ('downloading', 'repairing') THEN root_cid END) as active,
        COUNT(DISTINCT root_cid) as total,
        COALESCE(SUM(bytes_transferred), 0) as bytes
      FROM uploads
      WHERE space_name IN (${placeholders})
      GROUP BY space_name ORDER BY total DESC
    `).all(...spaceNames) as any[]
  }

  getActiveJobs(limit = 5): Array<{ space_name: string; root_cid: string; status: string }> {
    return this._getActiveJobs.all(limit) as any[]
  }

  getRecentDone(since: string, limit = 5): Array<{ space_name: string; root_cid: string }> {
    return this._getRecentDone.all({ since, limit }) as any[]
  }

  getRecentErrors(since: string, limit = 10): Array<{ space_name: string; root_cid: string; error_msg: string | null }> {
    return this._getRecentErrors.all({ since, limit }) as any[]
  }
}

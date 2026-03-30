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
  private _getStats: Database.Statement
  private _getComplete: Database.Statement
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
      WHERE status IN ('error', 'partial', 'downloading')
    `)

    this._getStats = db.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) as complete,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as error,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status = 'downloading' THEN 1 ELSE 0 END), 0) as downloading,
        COALESCE(SUM(CASE WHEN status = 'partial' THEN 1 ELSE 0 END), 0) as partial,
        COALESCE(SUM(CASE WHEN status = 'repairing' THEN 1 ELSE 0 END), 0) as repairing,
        COALESCE(SUM(bytes_transferred), 0) as total_bytes
      FROM uploads
    `)

    this._getComplete = db.prepare(`SELECT * FROM uploads WHERE backend = @backend AND status = 'complete'`)

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
        COALESCE(SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END), 0) as done,
        COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) as errors,
        COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) as pending,
        COALESCE(SUM(CASE WHEN status IN ('downloading', 'repairing') THEN 1 ELSE 0 END), 0) as active,
        COUNT(*) as total,
        COALESCE(SUM(bytes_transferred), 0) as bytes
      FROM uploads
      WHERE space_name IN (${placeholders})
      GROUP BY space_name ORDER BY total DESC
    `).all(...spaceNames) as any[]
  }

  getActiveJobs(limit = 5): Array<{ space_name: string; root_cid: string; status: string }> {
    return this.db.prepare(
      "SELECT space_name, root_cid, status FROM uploads WHERE status IN ('downloading', 'repairing') ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as any[]
  }

  getRecentDone(limit = 5): Array<{ space_name: string; root_cid: string }> {
    return this.db.prepare(
      "SELECT space_name, root_cid FROM uploads WHERE status = 'complete' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as any[]
  }

  getRecentErrors(limit = 10): Array<{ space_name: string; root_cid: string; error_msg: string | null }> {
    return this.db.prepare(
      "SELECT space_name, root_cid, error_msg FROM uploads WHERE status = 'error' ORDER BY updated_at DESC LIMIT ?"
    ).all(limit) as any[]
  }
}

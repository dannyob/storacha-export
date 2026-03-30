import Database from 'better-sqlite3'

export class JobQueue {
  constructor(dbPath = 'storacha-export.db') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this._createTables()
    this._prepareStatements()
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        root_cid TEXT NOT NULL,
        space_did TEXT NOT NULL,
        space_name TEXT,
        backend TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        error_msg TEXT,
        bytes_transferred INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (root_cid, backend)
      );

      CREATE TABLE IF NOT EXISTS spaces (
        did TEXT PRIMARY KEY,
        name TEXT,
        total_uploads INTEGER,
        total_bytes INTEGER,
        enumerated_at TEXT
      );
    `)
  }

  _prepareStatements() {
    this._insertJob = this.db.prepare(`
      INSERT OR IGNORE INTO jobs (root_cid, space_did, space_name, backend)
      VALUES (@rootCid, @spaceDid, @spaceName, @backend)
    `)
    this._markDone = this.db.prepare(`
      UPDATE jobs SET status = 'done', bytes_transferred = @bytes,
        updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)
    this._markError = this.db.prepare(`
      UPDATE jobs SET status = 'error', error_msg = @errorMsg,
        updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)
    this._markInProgress = this.db.prepare(`
      UPDATE jobs SET status = 'in_progress', updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)
    this._getPending = this.db.prepare(`
      SELECT * FROM jobs WHERE backend = @backend AND status = 'pending'
    `)
    this._resetErrors = this.db.prepare(`
      UPDATE jobs SET status = 'pending', error_msg = NULL,
        updated_at = datetime('now')
      WHERE status = 'error'
    `)
    this._resetInProgress = this.db.prepare(`
      UPDATE jobs SET status = 'pending',
        updated_at = datetime('now')
      WHERE status = 'in_progress'
    `)
    this._upsertSpace = this.db.prepare(`
      INSERT INTO spaces (did, name, total_uploads, total_bytes, enumerated_at)
      VALUES (@did, @name, @totalUploads, @totalBytes, datetime('now'))
      ON CONFLICT(did) DO UPDATE SET
        name = @name, total_uploads = @totalUploads, total_bytes = @totalBytes,
        enumerated_at = datetime('now')
    `)
    this._getSpace = this.db.prepare(`SELECT * FROM spaces WHERE did = @did`)
    this._getStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
      FROM jobs
    `)
  }

  addJob({ rootCid, spaceDid, spaceName, backend }) {
    this._insertJob.run({ rootCid, spaceDid, spaceName, backend })
  }

  addJobsBatch(jobs) {
    const insert = this.db.transaction((items) => {
      for (const job of items) {
        this._insertJob.run(job)
      }
    })
    insert(jobs)
  }

  markInProgress(rootCid, backend) {
    this._markInProgress.run({ rootCid, backend })
  }

  markDone(rootCid, backend, bytes) {
    this._markDone.run({ rootCid, backend, bytes })
  }

  markError(rootCid, backend, errorMsg) {
    this._markError.run({ rootCid, backend, errorMsg })
  }

  getPending(backend) {
    return this._getPending.all({ backend })
  }

  resetErrors() {
    return this._resetErrors.run()
  }

  resetInProgress() {
    return this._resetInProgress.run()
  }

  upsertSpace({ did, name, totalUploads, totalBytes }) {
    this._upsertSpace.run({ did, name, totalUploads, totalBytes })
  }

  getSpace(did) {
    return this._getSpace.get({ did })
  }

  getStats() {
    return this._getStats.get()
  }

  getPendingCountForSpaces(spaceNames) {
    const placeholders = spaceNames.map(() => '?').join(',')
    return this.db.prepare(
      `SELECT COUNT(*) as count FROM jobs WHERE status = 'pending' AND space_name IN (${placeholders})`
    ).get(...spaceNames)?.count || 0
  }

  getTotalBytesTransferred() {
    return this.db.prepare(
      "SELECT COALESCE(SUM(bytes_transferred), 0) as total FROM jobs WHERE status = 'done'"
    ).get().total
  }

  getErrors() {
    return this.db.prepare(
      "SELECT root_cid, space_name, backend, error_msg FROM jobs WHERE status = 'error'"
    ).all()
  }

  getStatsBySpace(spaceNames) {
    const placeholders = spaceNames.map(() => '?').join(',')
    return this.db.prepare(`
      SELECT space_name,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as active,
        COUNT(*) as total,
        COALESCE(SUM(bytes_transferred), 0) as bytes
      FROM jobs
      WHERE space_name IN (${placeholders})
      GROUP BY space_name ORDER BY total DESC
    `).all(...spaceNames)
  }

  getActiveJobs(limit = 5) {
    return this.db.prepare(
      'SELECT space_name, root_cid, updated_at FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?'
    ).all('in_progress', limit)
  }

  getRecentDone(limit = 5) {
    return this.db.prepare(
      'SELECT space_name, root_cid, bytes_transferred, updated_at FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?'
    ).all('done', limit)
  }

  getRecentErrors(limit = 10) {
    return this.db.prepare(
      'SELECT space_name, root_cid, error_msg, updated_at FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?'
    ).all('error', limit)
  }

  close() {
    this.db.close()
  }
}

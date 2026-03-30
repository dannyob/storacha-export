import Database from 'better-sqlite3'

export function createDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('journal_mode = WAL')

  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      root_cid TEXT NOT NULL,
      space_did TEXT NOT NULL,
      space_name TEXT,
      backend TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      error_msg TEXT,
      attempt_count INTEGER DEFAULT 0,
      bytes_transferred INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (root_cid, backend)
    );

    CREATE TABLE IF NOT EXISTS blocks (
      root_cid TEXT NOT NULL,
      block_cid TEXT NOT NULL,
      codec INTEGER NOT NULL,
      seen INTEGER DEFAULT 0,
      linked_by TEXT,
      PRIMARY KEY (root_cid, block_cid)
    );

    CREATE INDEX IF NOT EXISTS idx_blocks_unseen
      ON blocks(root_cid, seen) WHERE seen = 0;

    CREATE TABLE IF NOT EXISTS spaces (
      did TEXT PRIMARY KEY,
      name TEXT,
      total_uploads INTEGER,
      total_bytes INTEGER,
      enumerated_at TEXT
    );
  `)

  return db
}

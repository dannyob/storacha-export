import { describe, it, expect, afterEach } from 'vitest'
import { createDatabase } from '../../src/core/db.js'
import fs from 'node:fs'

const TEST_DB = '/tmp/storacha-v2-db-test.db'

afterEach(() => {
  try { fs.unlinkSync(TEST_DB) } catch {}
  try { fs.unlinkSync(TEST_DB + '-journal') } catch {}
  try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
  try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
})

describe('createDatabase', () => {
  it('creates tables on init', () => {
    const db = createDatabase(TEST_DB)
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map((r: any) => r.name)

    expect(tables).toContain('uploads')
    expect(tables).toContain('blocks')
    expect(tables).toContain('spaces')
    db.close()
  })

  it('is idempotent — second call does not error', () => {
    const db1 = createDatabase(TEST_DB)
    db1.close()
    const db2 = createDatabase(TEST_DB)
    db2.close()
  })
})

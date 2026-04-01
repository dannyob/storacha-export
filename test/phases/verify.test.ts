import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runVerify } from '../../src/phases/verify.js'
import { UploadQueue } from '../../src/core/queue.js'
import { createDatabase } from '../../src/core/db.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { ExportBackend } from '../../src/backends/interface.js'

const TEST_DB = '/tmp/storacha-v2-verify-test.db'

describe('runVerify', () => {
  let db: Database.Database
  let queue: UploadQueue

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    queue = new UploadQueue(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('verifies complete uploads', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
      async verifyDag() { return { valid: true } },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(result.verified).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('moves failed verification back to partial', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
      async verifyDag() { return { valid: false, error: 'missing blocks' } },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(result.verified).toBe(0)
    expect(result.failed).toBe(1)
    expect(queue.getStatus('bafyA', 'mock')).toBe('partial')
  })

  it('falls back to hasContent when verifyDag not available', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(result.verified).toBe(1)
  })
})

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { UploadQueue, UploadStatus } from '../../src/core/queue.js'
import { createDatabase } from '../../src/core/db.js'
import fs from 'node:fs'
import type Database from 'better-sqlite3'

const TEST_DB = '/tmp/storacha-v2-queue-test.db'

describe('UploadQueue', () => {
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

  it('adds and retrieves pending uploads', () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    const pending = queue.getPending('kubo')
    expect(pending).toHaveLength(1)
    expect(pending[0].root_cid).toBe('bafyA')
  })

  it('skips duplicates on insert', () => {
    const upload = { rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' }
    queue.add(upload)
    queue.add(upload)
    expect(queue.getPending('kubo')).toHaveLength(1)
  })

  it('transitions through lifecycle states', () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })

    queue.setStatus('bafyA', 'kubo', 'downloading')
    expect(queue.getStatus('bafyA', 'kubo')).toBe('downloading')

    queue.setStatus('bafyA', 'kubo', 'partial')
    expect(queue.getStatus('bafyA', 'kubo')).toBe('partial')

    queue.setStatus('bafyA', 'kubo', 'repairing')
    expect(queue.getStatus('bafyA', 'kubo')).toBe('repairing')

    queue.markComplete('bafyA', 'kubo', 12345)
    expect(queue.getStatus('bafyA', 'kubo')).toBe('complete')
  })

  it('markError records message and increments attempt count', () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.markError('bafyA', 'kubo', 'fetch failed')
    const upload = queue.get('bafyA', 'kubo')
    expect(upload?.status).toBe('error')
    expect(upload?.error_msg).toBe('fetch failed')
    expect(upload?.attempt_count).toBe(1)
  })

  it('resetForRetry moves error and partial back to pending', () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.add({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.markError('bafyA', 'kubo', 'timeout')
    queue.setStatus('bafyB', 'kubo', 'partial')

    const count = queue.resetForRetry()
    expect(count).toBe(2)
    expect(queue.getStatus('bafyA', 'kubo')).toBe('pending')
    expect(queue.getStatus('bafyB', 'kubo')).toBe('pending')
  })

  it('getStats returns correct counts', () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.add({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.add({ rootCid: 'bafyC', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.markComplete('bafyA', 'kubo', 100)
    queue.markError('bafyB', 'kubo', 'fail')

    const stats = queue.getStats()
    expect(stats.complete).toBe(1)
    expect(stats.error).toBe(1)
    expect(stats.pending).toBe(1)
    expect(stats.total).toBe(3)
  })

  it('getPendingForSpaces filters by space name', () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'SpaceA', backend: 'kubo' })
    queue.add({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk2', spaceName: 'SpaceB', backend: 'kubo' })
    const pending = queue.getPendingForSpaces('kubo', ['SpaceA'])
    expect(pending).toHaveLength(1)
    expect(pending[0].space_name).toBe('SpaceA')
  })

  it('addBatch inserts many uploads in a transaction', () => {
    const uploads = Array.from({ length: 100 }, (_, i) => ({
      rootCid: `bafy${i}`,
      spaceDid: 'did:key:z6Mk1',
      spaceName: 'S1',
      backend: 'kubo',
    }))
    queue.addBatch(uploads)
    expect(queue.getStats().total).toBe(100)
  })
})

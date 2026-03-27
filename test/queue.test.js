import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueue } from '../src/queue.js'
import fs from 'node:fs'

const TEST_DB = '/tmp/storacha-export-test.db'

describe('JobQueue', () => {
  let queue

  beforeEach(() => {
    queue = new JobQueue(TEST_DB)
  })

  afterEach(() => {
    queue.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-journal') } catch {}
  })

  it('creates tables on init', () => {
    const tables = queue.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name)
    assert.ok(tables.includes('jobs'))
    assert.ok(tables.includes('spaces'))
  })

  it('adds jobs and retrieves pending', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    const pending = queue.getPending('local')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].root_cid, 'bafytest1')
    assert.equal(pending[0].space_name, 'TestSpace')
  })

  it('skips duplicate jobs on insert', () => {
    const job = {
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    }
    queue.addJob(job)
    queue.addJob(job) // duplicate
    const pending = queue.getPending('local')
    assert.equal(pending.length, 1)
  })

  it('marks job done', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    queue.markDone('bafytest1', 'local', 12345)
    const pending = queue.getPending('local')
    assert.equal(pending.length, 0)
    const stats = queue.getStats()
    assert.equal(stats.done, 1)
  })

  it('marks job error', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    queue.markError('bafytest1', 'local', 'connection refused')
    const pending = queue.getPending('local')
    assert.equal(pending.length, 0)
    const stats = queue.getStats()
    assert.equal(stats.error, 1)
  })

  it('resets errored jobs for retry', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    queue.markError('bafytest1', 'local', 'timeout')
    queue.resetErrors()
    const pending = queue.getPending('local')
    assert.equal(pending.length, 1)
  })

  it('records space info', () => {
    queue.upsertSpace({
      did: 'did:key:z6Mktest',
      name: 'TestSpace',
      totalUploads: 42,
      totalBytes: 1000000
    })
    const space = queue.getSpace('did:key:z6Mktest')
    assert.equal(space.name, 'TestSpace')
    assert.equal(space.total_uploads, 42)
  })

  it('reports progress stats', () => {
    queue.addJob({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'local' })
    queue.addJob({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'local' })
    queue.addJob({ rootCid: 'bafyC', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'local' })
    queue.markDone('bafyA', 'local', 500)
    queue.markError('bafyB', 'local', 'fail')
    const stats = queue.getStats()
    assert.equal(stats.total, 3)
    assert.equal(stats.done, 1)
    assert.equal(stats.error, 1)
    assert.equal(stats.pending, 1)
  })
})

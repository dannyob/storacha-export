import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import { JobQueue } from '../src/queue.js'

const TEST_DB = '/tmp/storacha-export-dashboard-test.db'

describe('queue: dashboard queries', () => {
  let queue

  beforeEach(() => {
    queue = new JobQueue(TEST_DB)
    // Set up test data: 3 spaces, various statuses
    queue.addJob({ rootCid: 'bafyA1', spaceDid: 'did:key:z6MkA', spaceName: 'SpaceA', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyA2', spaceDid: 'did:key:z6MkA', spaceName: 'SpaceA', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyB1', spaceDid: 'did:key:z6MkB', spaceName: 'SpaceB', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyC1', spaceDid: 'did:key:z6MkC', spaceName: 'SpaceC', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyC2', spaceDid: 'did:key:z6MkC', spaceName: 'SpaceC', backend: 'kubo' })

    queue.markDone('bafyA1', 'kubo', 1000)
    queue.markError('bafyA2', 'kubo', 'fetch failed')
    queue.markInProgress('bafyB1', 'kubo')
    // bafyC1, bafyC2 stay pending
  })

  afterEach(() => {
    queue.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-journal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
  })

  it('getStatsBySpace returns per-space breakdown', () => {
    const stats = queue.getStatsBySpace(['SpaceA', 'SpaceB', 'SpaceC'])
    assert.equal(stats.length, 3)

    const a = stats.find(s => s.space_name === 'SpaceA')
    assert.equal(a.done, 1)
    assert.equal(a.errors, 1)
    assert.equal(a.pending, 0)
    assert.equal(a.total, 2)

    const b = stats.find(s => s.space_name === 'SpaceB')
    assert.equal(b.active, 1)

    const c = stats.find(s => s.space_name === 'SpaceC')
    assert.equal(c.pending, 2)
  })

  it('getStatsBySpace filters to selected spaces only', () => {
    const stats = queue.getStatsBySpace(['SpaceA'])
    assert.equal(stats.length, 1)
    assert.equal(stats[0].space_name, 'SpaceA')
  })

  it('getActiveJobs returns in_progress jobs', () => {
    const active = queue.getActiveJobs()
    assert.equal(active.length, 1)
    assert.equal(active[0].root_cid, 'bafyB1')
    assert.equal(active[0].space_name, 'SpaceB')
  })

  it('getRecentDone returns completed jobs', () => {
    const done = queue.getRecentDone()
    assert.equal(done.length, 1)
    assert.equal(done[0].root_cid, 'bafyA1')
    assert.equal(done[0].bytes_transferred, 1000)
  })

  it('getRecentErrors returns error details', () => {
    const errors = queue.getRecentErrors()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].root_cid, 'bafyA2')
    assert.equal(errors[0].error_msg, 'fetch failed')
  })
})

describe('server', () => {
  it('startDashboard serves HTML from getHtml callback', async () => {
    const { startDashboard } = await import('../src/server.js')
    const { server, url } = await startDashboard({
      getHtml: () => '<html><body>test dashboard</body></html>',
    })

    const res = await fetch(url)
    const text = await res.text()
    assert.ok(text.includes('test dashboard'))
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')

    await new Promise(resolve => server.close(resolve))
  })

  it('startDashboard enforces password when set', async () => {
    const { startDashboard } = await import('../src/server.js')
    const { server, url } = await startDashboard({
      password: 'secret123',
      getHtml: () => '<html>private</html>',
    })

    // No auth → 401
    const noAuth = await fetch(url)
    assert.equal(noAuth.status, 401)

    // Wrong auth → 401
    const wrongAuth = await fetch(url, {
      headers: { Authorization: 'Basic ' + Buffer.from(':wrong').toString('base64') },
    })
    assert.equal(wrongAuth.status, 401)

    // Correct auth → 200
    const goodAuth = await fetch(url, {
      headers: { Authorization: 'Basic ' + Buffer.from(':secret123').toString('base64') },
    })
    assert.equal(goodAuth.status, 200)
    const text = await goodAuth.text()
    assert.ok(text.includes('private'))

    await new Promise(resolve => server.close(resolve))
  })

  it('startDashboard binds to specified port', async () => {
    const { startDashboard } = await import('../src/server.js')
    const { server, url } = await startDashboard({
      port: 0, // random
      getHtml: () => '<html>ok</html>',
    })

    assert.ok(url.startsWith('http://127.0.0.1:'))
    const res = await fetch(url)
    assert.equal(res.status, 200)

    await new Promise(resolve => server.close(resolve))
  })
})

describe('dashboard HTML generator', () => {
  it('generateDashboardHtml returns valid HTML with stats', async () => {
    const { generateDashboardHtml } = await import('../src/dashboard.js')
    const html = generateDashboardHtml({
      stats: { total: 100, done: 50, error: 5, pending: 45 },
      bySpace: [
        { space_name: 'TestSpace', done: 50, errors: 5, pending: 45, active: 0, total: 100, bytes: 5000000 },
      ],
      spaceSizes: { TestSpace: 10000000 },
      activeJobs: [],
      recentDone: [
        { space_name: 'TestSpace', root_cid: 'bafytest123456789012345678', bytes_transferred: 1000000, updated_at: '2026-03-29 21:00:00' },
      ],
      recentErrors: [],
      logLines: '2026-03-29 21:00:00 [12345] DONE test line',
      pid: 12345,
    })

    assert.ok(html.includes('<!DOCTYPE html>'))
    assert.ok(html.includes('TestSpace'))
    assert.ok(html.includes('50'))
    assert.ok(html.includes('12345'))
    assert.ok(html.includes('test line'))
  })
})

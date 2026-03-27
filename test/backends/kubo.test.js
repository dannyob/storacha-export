import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { KuboBackend } from '../../src/backends/kubo.js'

describe('KuboBackend', () => {
  it('has name "kubo"', () => {
    const backend = new KuboBackend({ apiUrl: 'http://127.0.0.1:5001' })
    assert.equal(backend.name, 'kubo')
  })

  it('parses multiaddr to URL', () => {
    const backend = new KuboBackend({ apiUrl: '/ip4/127.0.0.1/tcp/5001' })
    assert.equal(backend.apiUrl, 'http://127.0.0.1:5001')
  })

  it('passes through http URLs', () => {
    const backend = new KuboBackend({ apiUrl: 'http://localhost:5001' })
    assert.equal(backend.apiUrl, 'http://localhost:5001')
  })

  // Integration tests (require a running kubo node) are skipped by default.
  // Run with: KUBO_API=http://127.0.0.1:5001 npm test
})

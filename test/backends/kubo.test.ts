import { describe, it, expect } from 'vitest'
import { KuboBackend } from '../../src/backends/kubo.js'

describe('KuboBackend', () => {
  it('has name "kubo"', () => {
    const backend = new KuboBackend({ apiUrl: 'http://127.0.0.1:5001' })
    expect(backend.name).toBe('kubo')
  })

  it('parses multiaddr to URL', () => {
    const backend = new KuboBackend({ apiUrl: '/ip4/127.0.0.1/tcp/5001' })
    expect(backend.apiUrl).toBe('http://127.0.0.1:5001')
  })

  it('passes through http URLs', () => {
    const backend = new KuboBackend({ apiUrl: 'http://localhost:5001' })
    expect(backend.apiUrl).toBe('http://localhost:5001')
  })
})

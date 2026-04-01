import { describe, it, expect } from 'vitest'
import { ClusterBackend } from '../../src/backends/cluster.js'

describe('ClusterBackend', () => {
  it('has name "cluster"', () => {
    const backend = new ClusterBackend({ apiUrl: 'http://127.0.0.1:9094' })
    expect(backend.name).toBe('cluster')
  })

  it('strips trailing slash from URL', () => {
    const backend = new ClusterBackend({ apiUrl: 'http://127.0.0.1:9094/' })
    expect(backend.apiUrl).toBe('http://127.0.0.1:9094')
  })
})

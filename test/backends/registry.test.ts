import { describe, it, expect } from 'vitest'
import { createBackend } from '../../src/backends/registry.js'

describe('createBackend', () => {
  it('rejects removed cluster backend', () => {
    expect(() => createBackend('cluster', {})).toThrow(/Unknown backend/)
  })
})

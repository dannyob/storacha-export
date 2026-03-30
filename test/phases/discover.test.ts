import { describe, it, expect } from 'vitest'
import { detectCredentials } from '../../src/auth.js'

describe('detectCredentials', () => {
  it('returns object with hasCredentials boolean', async () => {
    const result = await detectCredentials()
    expect(typeof result.hasCredentials).toBe('boolean')
  })

  it('returns spaces array', async () => {
    const result = await detectCredentials()
    expect(Array.isArray(result.spaces)).toBe(true)
  })
})

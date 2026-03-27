import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectCredentials } from '../src/auth.js'

describe('auth', () => {
  it('detectCredentials returns object with hasCredentials boolean', async () => {
    const result = await detectCredentials()
    assert.equal(typeof result.hasCredentials, 'boolean')
    // On a dev machine with storacha configured, this will be true.
    // On CI with no credentials, this will be false.
    // Either way the shape is correct.
  })

  it('detectCredentials returns spaces array', async () => {
    const result = await detectCredentials()
    assert.ok(Array.isArray(result.spaces))
  })
})

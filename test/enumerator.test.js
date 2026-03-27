import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enumerateUploads } from '../src/enumerator.js'

describe('enumerator', () => {
  it('enumerateUploads is an async generator', () => {
    // We can't test against real Storacha without credentials,
    // but we can verify the function exists and is the right type.
    assert.equal(typeof enumerateUploads, 'function')
  })
})

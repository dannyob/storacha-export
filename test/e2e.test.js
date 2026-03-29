import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('e2e: storacha-export', () => {
  it('shows help', () => {
    const out = execFileSync('node', ['bin/storacha-export.js', '--help'], {
      encoding: 'utf8',
    })
    assert.ok(out.includes('storacha-export'))
    assert.ok(out.includes('--backend'))
    assert.ok(out.includes('--space'))
    assert.ok(out.includes('--exclude-space'))
    assert.ok(out.includes('--fresh'))
  })

  it('shows version', () => {
    const out = execFileSync('node', ['bin/storacha-export.js', '--version'], {
      encoding: 'utf8',
    })
    assert.ok(out.includes('0.1.0'))
  })
})

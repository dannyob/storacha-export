import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LocalBackend } from '../../src/backends/local.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'

describe('LocalBackend', () => {
  let tmpDir
  let backend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-test-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has name "local"', () => {
    assert.equal(backend.name, 'local')
  })

  it('hasContent returns false for missing CID', async () => {
    assert.equal(await backend.hasContent('bafynothere'), false)
  })

  it('importCar writes file and hasContent returns true', async () => {
    const data = Buffer.from('fake car data')
    const stream = Readable.from([data])
    await backend.importCar('bafytest123', stream)

    const filePath = path.join(tmpDir, 'bafytest123.car')
    assert.ok(fs.existsSync(filePath))
    assert.deepEqual(fs.readFileSync(filePath), data)
    assert.equal(await backend.hasContent('bafytest123'), true)
  })

  it('creates output directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'sub', 'dir')
    const be = new LocalBackend({ outputDir: nested })
    await be.init()
    assert.ok(fs.existsSync(nested))
  })
})

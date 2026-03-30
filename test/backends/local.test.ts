import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { LocalBackend } from '../../src/backends/local.js'
import { makeRawBlock, makeDagPBNode } from '../core/blocks.test.js'
import { CarBlockIterator } from '@ipld/car'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import type { Block } from '../../src/core/blocks.js'

describe('LocalBackend', () => {
  let tmpDir: string
  let backend: LocalBackend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-local-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has name "local"', () => {
    expect(backend.name).toBe('local')
  })

  it('hasContent returns false for missing CID', async () => {
    expect(await backend.hasContent('bafynothere')).toBe(false)
  })

  it('importCar writes a valid CAR file and hasContent returns true', async () => {
    const leaf = await makeRawBlock('test-data')
    const root = await makeDagPBNode([leaf])

    async function* blocks(): AsyncIterable<Block> {
      yield root
      yield leaf
    }

    await backend.importCar(root.cid.toString(), blocks())

    const carPath = path.join(tmpDir, `${root.cid.toString()}.car`)
    expect(fs.existsSync(carPath)).toBe(true)
    expect(await backend.hasContent(root.cid.toString())).toBe(true)
  })

  it('creates output directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'sub', 'dir')
    const be = new LocalBackend({ outputDir: nested })
    await be.init()
    expect(fs.existsSync(nested)).toBe(true)
  })

  it('verifyDag checks CAR is parseable', async () => {
    const leaf = await makeRawBlock('verify-test')
    const root = await makeDagPBNode([leaf])

    async function* blocks(): AsyncIterable<Block> {
      yield root
      yield leaf
    }

    await backend.importCar(root.cid.toString(), blocks())
    const result = await backend.verifyDag!(root.cid.toString())
    expect(result.valid).toBe(true)
  })
})

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Writable, PassThrough } from 'node:stream'
import { CID } from 'multiformats/cid'
import { CarWriter } from '@ipld/car'
import { importer, type ImportCandidate } from 'ipfs-unixfs-importer'
import { extract as tarExtract } from 'tar-stream'

import { convert } from '../car-to-tar.mts'

// --- Test helpers ---

interface TestBlockstore {
  get(cid: CID): Promise<Uint8Array>
  put(cid: CID, bytes: Uint8Array): Promise<void>
}

function memBlockstore(): TestBlockstore & { blocks: Map<string, Uint8Array> } {
  const blocks = new Map<string, Uint8Array>()
  return {
    blocks,
    async put(cid, bytes) { blocks.set(cid.toString(), bytes) },
    async get(cid) {
      const b = blocks.get(cid.toString())
      if (!b) throw new Error(`missing block: ${cid}`)
      return b
    },
  }
}

/**
 * Build an in-memory CAR from candidates using ipfs-unixfs-importer.
 * Returns the path to the written CAR file and the root CID.
 */
async function buildCar(
  candidates: ImportCandidate[],
  outPath: string,
  options: { wrapWithDirectory?: boolean } = {},
): Promise<{ rootCid: CID; carPath: string; blocks: Map<string, Uint8Array> }> {
  const bs = memBlockstore()
  const allCids: CID[] = []
  for await (const entry of importer(candidates, bs as any, {
    wrapWithDirectory: options.wrapWithDirectory ?? false,
    rawLeaves: true,
  })) {
    allCids.push(entry.cid as unknown as CID)
  }
  const rootCid = allCids[allCids.length - 1]
  const { writer, out } = CarWriter.create([rootCid])
  // Write blocks
  ;(async () => {
    for (const [cidStr, bytes] of bs.blocks) {
      await writer.put({ cid: CID.parse(cidStr), bytes })
    }
    await writer.close()
  })()
  const chunks: Uint8Array[] = []
  for await (const chunk of out) chunks.push(chunk)
  const carBytes = Buffer.concat(chunks)
  fs.writeFileSync(outPath, carBytes)
  return { rootCid, carPath: outPath, blocks: bs.blocks }
}

/**
 * Write a CAR file from an explicit set of blocks with the given roots in
 * the header. Used to construct multi-shard test fixtures.
 */
async function writeCar(
  rootCids: CID[],
  blocks: Map<string, Uint8Array>,
  outPath: string,
): Promise<void> {
  const { writer, out } = CarWriter.create(rootCids)
  const writeProm = (async () => {
    for (const [cidStr, bytes] of blocks) {
      await writer.put({ cid: CID.parse(cidStr), bytes })
    }
    await writer.close()
  })()
  const chunks: Uint8Array[] = []
  for await (const chunk of out) chunks.push(chunk)
  await writeProm
  fs.writeFileSync(outPath, Buffer.concat(chunks))
}

/** Run convert() into a buffer, returning the tar bytes. */
async function convertToBuffer(opts: {
  carPaths: string[]
  root?: CID
}): Promise<{ tarBytes: Uint8Array; result: Awaited<ReturnType<typeof convert>> }> {
  const chunks: Uint8Array[] = []
  const sink = new Writable({
    write(chunk, _enc, cb) { chunks.push(chunk); cb() },
  })
  const result = await convert({
    carPaths: opts.carPaths,
    out: sink,
    root: opts.root,
    log: () => {}, // suppress warnings in tests by default
  })
  return { tarBytes: Buffer.concat(chunks), result }
}

interface TarEntry {
  name: string
  type: 'file' | 'directory' | 'symlink' | string
  size: number
  content: Uint8Array
}

/** Parse a tar buffer into entries. */
async function parseTar(tarBytes: Uint8Array): Promise<TarEntry[]> {
  const entries: TarEntry[] = []
  const ext = tarExtract()
  const through = new PassThrough()
  through.end(Buffer.from(tarBytes))
  await new Promise<void>((resolve, reject) => {
    ext.on('entry', (header, stream, next) => {
      const chunks: Uint8Array[] = []
      stream.on('data', c => chunks.push(c))
      stream.on('end', () => {
        entries.push({
          name: header.name,
          type: header.type as any,
          size: header.size ?? 0,
          content: Buffer.concat(chunks),
        })
        next()
      })
      stream.resume()
    })
    ext.on('finish', () => resolve())
    ext.on('error', reject)
    through.pipe(ext)
  })
  return entries
}

// --- Tests ---

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'car-to-tar-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('convert', () => {
  test('extracts a single file CAR to a tar with one entry named after the root CID', async () => {
    const fileContent = new TextEncoder().encode('hello world')
    const carPath = path.join(tmpDir, 'one.car')
    const { rootCid } = await buildCar(
      [{ content: fileContent }],
      carPath,
    )

    const { tarBytes, result } = await convertToBuffer({ carPaths: [carPath] })

    expect(result.extracted).toBe(1)
    expect(result.skipped).toBe(0)

    const entries = await parseTar(tarBytes)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe(rootCid.toString())
    expect(entries[0].type).toBe('file')
    expect(Buffer.from(entries[0].content).equals(Buffer.from(fileContent))).toBe(true)
  })

  test('extracts a directory CAR with two files at expected paths', async () => {
    const a = new TextEncoder().encode('alpha bytes')
    const b = new TextEncoder().encode('bravo bytes longer')
    const carPath = path.join(tmpDir, 'dir.car')
    await buildCar(
      [
        { path: 'alpha.txt', content: a },
        { path: 'bravo.txt', content: b },
      ],
      carPath,
      { wrapWithDirectory: true },
    )

    const { tarBytes, result } = await convertToBuffer({ carPaths: [carPath] })

    expect(result.skipped).toBe(0)

    const entries = await parseTar(tarBytes)
    const files = entries.filter(e => e.type === 'file')
    const names = files.map(e => e.name).sort()
    expect(names).toEqual(['alpha.txt', 'bravo.txt'])

    const alpha = files.find(e => e.name === 'alpha.txt')!
    const bravo = files.find(e => e.name === 'bravo.txt')!
    expect(Buffer.from(alpha.content).equals(Buffer.from(a))).toBe(true)
    expect(Buffer.from(bravo.content).equals(Buffer.from(b))).toBe(true)
  })

  test('joins multiple shard CARs that together form one DAG', async () => {
    // Build the full DAG, then partition the blocks into two CAR shards
    // each declaring the same root.
    const a = new TextEncoder().encode('alpha bytes')
    const b = new TextEncoder().encode('bravo bytes longer than alpha')
    const tmpFull = path.join(tmpDir, 'full.car')
    const { rootCid, blocks } = await buildCar(
      [
        { path: 'alpha.txt', content: a },
        { path: 'bravo.txt', content: b },
      ],
      tmpFull,
      { wrapWithDirectory: true },
    )

    // Partition blocks: first half → shard 0, second half → shard 1.
    // Both shards declare the upload root in their CAR header.
    const blockEntries = [...blocks]
    const half = Math.ceil(blockEntries.length / 2)
    const shard0 = new Map(blockEntries.slice(0, half))
    const shard1 = new Map(blockEntries.slice(half))
    const shard0Path = path.join(tmpDir, 'shard-0.car')
    const shard1Path = path.join(tmpDir, 'shard-1.car')
    await writeCar([rootCid], shard0, shard0Path)
    await writeCar([rootCid], shard1, shard1Path)

    const { tarBytes, result } = await convertToBuffer({
      carPaths: [shard0Path, shard1Path],
    })

    expect(result.skipped).toBe(0)
    const entries = await parseTar(tarBytes)
    const names = entries.filter(e => e.type === 'file').map(e => e.name).sort()
    expect(names).toEqual(['alpha.txt', 'bravo.txt'])
  })

  test('skips files with missing blocks, logs a warning, and still produces a parseable tar', async () => {
    // Build the full DAG in memory, then write a CAR that is missing
    // bravo.txt's leaf block — alpha.txt should still extract.
    const a = new TextEncoder().encode('alpha bytes')
    const b = new TextEncoder().encode('bravo bytes longer than alpha')
    const bs = memBlockstore()
    const importedCids: { path: string; cid: CID }[] = []
    for await (const e of importer(
      [
        { path: 'alpha.txt', content: a },
        { path: 'bravo.txt', content: b },
      ],
      bs as any,
      { wrapWithDirectory: true, rawLeaves: true },
    )) {
      importedCids.push({ path: e.path ?? '', cid: e.cid as unknown as CID })
    }
    const rootCid = importedCids[importedCids.length - 1].cid
    const bravoCid = importedCids.find(e => e.path === 'bravo.txt')!.cid

    // Construct partial block map: drop bravo's leaf
    const partialBlocks = new Map(bs.blocks)
    partialBlocks.delete(bravoCid.toString())

    const carPath = path.join(tmpDir, 'partial.car')
    await writeCar([rootCid], partialBlocks, carPath)

    const warnings: string[] = []
    const chunks: Uint8Array[] = []
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb() },
    })
    const result = await convert({
      carPaths: [carPath],
      out: sink,
      log: m => warnings.push(m),
    })

    expect(result.extracted).toBe(1)        // alpha extracted
    expect(result.skipped).toBe(1)          // bravo skipped
    expect(result.warnings).toBeGreaterThanOrEqual(1)
    expect(warnings.some(w => w.includes('bravo.txt'))).toBe(true)

    // Tar must still be parseable and contain alpha
    const tarBytes = Buffer.concat(chunks)
    const entries = await parseTar(tarBytes)
    const names = entries.filter(e => e.type === 'file').map(e => e.name)
    expect(names).toEqual(['alpha.txt'])
    expect(Buffer.from(entries.find(e => e.name === 'alpha.txt')!.content).equals(Buffer.from(a))).toBe(true)
  })

  test('errors when input CARs declare disagreeing roots and --root is not given', async () => {
    const car1 = path.join(tmpDir, 'one.car')
    const car2 = path.join(tmpDir, 'two.car')
    const { rootCid: root1 } = await buildCar([{ content: new TextEncoder().encode('one') }], car1)
    const { rootCid: root2 } = await buildCar([{ content: new TextEncoder().encode('two') }], car2)
    expect(root1.toString()).not.toBe(root2.toString())

    const sink = new Writable({ write(_c, _e, cb) { cb() } })
    await expect(convert({ carPaths: [car1, car2], out: sink, log: () => {} })).rejects.toThrow(/disagreeing roots/)
  })

  test('--root override picks one CAR\'s DAG when headers disagree', async () => {
    const car1 = path.join(tmpDir, 'one.car')
    const car2 = path.join(tmpDir, 'two.car')
    const oneBytes = new TextEncoder().encode('one')
    const { rootCid: root1 } = await buildCar([{ content: oneBytes }], car1)
    await buildCar([{ content: new TextEncoder().encode('two') }], car2)

    const { tarBytes, result } = await convertToBuffer({
      carPaths: [car1, car2],
      root: root1,
    })

    expect(result.extracted).toBe(1)
    const entries = await parseTar(tarBytes)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe(root1.toString())
    expect(Buffer.from(entries[0].content).equals(Buffer.from(oneBytes))).toBe(true)
  })
})

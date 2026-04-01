import fs from 'node:fs'
import path from 'node:path'
import { CarWriter, CarBlockIterator } from '@ipld/car'
import * as dagPB from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import type { ExportBackend } from './interface.js'
import type { BlockStream } from '../core/blocks.js'
import { log } from '../util/log.js'

const RAW_CODEC = 0x55
const DAG_PB_CODEC = 0x70

export class LocalBackend implements ExportBackend {
  name = 'local' as const

  private repairWriters = new Map<string, {
    writer: ReturnType<typeof CarWriter.create>['writer']
    drainPromise: Promise<void>
  }>()

  constructor(private options: { outputDir: string }) {}

  get outputDir() { return this.options.outputDir }

  async init(): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true })
  }

  async hasContent(rootCid: string): Promise<boolean> {
    return fs.existsSync(this.carPath(rootCid))
  }

  async importCar(rootCid: string, stream: BlockStream | AsyncIterable<Uint8Array> | NodeJS.ReadableStream): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true })
    const filePath = this.carPath(rootCid)

    // Detect if this is a raw byte stream or a BlockStream
    // by peeking at the first chunk — Blocks have { cid, bytes }, raw is Uint8Array/Buffer
    const iter = (stream as AsyncIterable<any>)[Symbol.asyncIterator]()
    const first = await iter.next()
    if (first.done) return

    if (first.value && first.value.cid) {
      // BlockStream — re-serialize to CAR
      const rootCidObj = CID.parse(rootCid)
      const { writer, out } = CarWriter.create([rootCidObj])
      const fileStream = fs.createWriteStream(filePath)
      const drain = (async () => {
        for await (const chunk of out) fileStream.write(chunk)
        fileStream.end()
        await new Promise<void>((resolve, reject) => { fileStream.on('finish', resolve); fileStream.on('error', reject) })
      })()
      await writer.put(first.value)
      for (let next = await iter.next(); !next.done; next = await iter.next()) {
        await writer.put(next.value)
      }
      await writer.close()
      await drain
    } else {
      // Raw byte stream — write directly
      const fileStream = fs.createWriteStream(filePath)
      fileStream.write(first.value)
      for (let next = await iter.next(); !next.done; next = await iter.next()) {
        fileStream.write(next.value)
      }
      fileStream.end()
      await new Promise<void>((resolve, reject) => { fileStream.on('finish', resolve); fileStream.on('error', reject) })
    }
  }

  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    const filePath = this.carPath(rootCid)
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'CAR file not found' }
    }
    try {
      const stream = fs.createReadStream(filePath)
      const iterator = await CarBlockIterator.fromIterable(stream)
      const blocks = new Map<string, { codec: number; links: string[] }>()
      for await (const { cid, bytes } of iterator) {
        const cidStr = cid.toString()
        if (cid.code === DAG_PB_CODEC) {
          const node = dagPB.decode(bytes)
          blocks.set(cidStr, {
            codec: cid.code,
            links: node.Links.map(link => link.Hash.toString()),
          })
        } else {
          blocks.set(cidStr, { codec: cid.code, links: [] })
        }
      }

      if (!blocks.has(rootCid)) {
        return { valid: false, error: `Root block missing: ${rootCid}` }
      }

      const stack = [rootCid]
      const visited = new Set<string>()

      while (stack.length > 0) {
        const cidStr = stack.pop()!
        if (visited.has(cidStr)) continue
        visited.add(cidStr)

        const block = blocks.get(cidStr)
        if (!block) {
          return { valid: false, error: `Missing reachable block: ${cidStr}` }
        }

        if (block.codec === DAG_PB_CODEC) {
          for (const link of block.links) {
            stack.push(link)
          }
          continue
        }

        if (block.codec === RAW_CODEC) {
          continue
        }

        return { valid: false, error: `Unsupported codec for reachable block: ${cidStr} (0x${block.codec.toString(16)})` }
      }

      return { valid: true }
    } catch (err: any) {
      return { valid: false, error: err.message }
    }
  }

  async putBlock(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void> {
    if (!rootCid) throw new Error('putBlock requires rootCid for local backend')

    if (!this.repairWriters.has(rootCid)) {
      const repairPath = this.carPath(rootCid) + '.repair'
      fs.mkdirSync(this.outputDir, { recursive: true })
      const rootCidObj = CID.parse(rootCid)
      const { writer, out } = CarWriter.create([rootCidObj])
      const fileStream = fs.createWriteStream(repairPath)
      const drainPromise = (async () => {
        for await (const chunk of out) fileStream.write(chunk)
        fileStream.end()
        await new Promise<void>((resolve, reject) => {
          fileStream.on('finish', resolve)
          fileStream.on('error', reject)
        })
      })()
      this.repairWriters.set(rootCid, { writer, drainPromise })
    }

    const { writer } = this.repairWriters.get(rootCid)!
    const cidObj = CID.parse(cid)
    await writer.put({ cid: cidObj, bytes })
  }

  async mergeRepairCar(rootCid: string): Promise<void> {
    const mainPath = this.carPath(rootCid)
    const repairPath = mainPath + '.repair'

    // Close any open writer for this root (must happen before existsSync —
    // createWriteStream may not have flushed the file to disk yet)
    await this.closeRepairWriter(rootCid)

    if (!fs.existsSync(repairPath)) return

    // Read all blocks from both files, deduplicate by CID
    const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>()

    // Read main CAR (may be truncated)
    if (fs.existsSync(mainPath)) {
      try {
        const stream = fs.createReadStream(mainPath)
        const iter = await CarBlockIterator.fromIterable(stream)
        for await (const block of iter) {
          blocks.set(block.cid.toString(), block)
        }
      } catch {
        // Truncated main CAR — got what we got
      }
    }

    // Read repair sidecar
    try {
      const stream = fs.createReadStream(repairPath)
      const iter = await CarBlockIterator.fromIterable(stream)
      for await (const block of iter) {
        blocks.set(block.cid.toString(), block)
      }
    } catch {
      // Truncated repair CAR — got what we got
    }

    // Write merged CAR
    const tempPath = mainPath + '.merge'
    const rootCidObj = CID.parse(rootCid)
    const { writer, out } = CarWriter.create([rootCidObj])
    const fileStream = fs.createWriteStream(tempPath)
    const drain = (async () => {
      for await (const chunk of out) fileStream.write(chunk)
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    })()

    for (const block of blocks.values()) {
      await writer.put(block)
    }
    await writer.close()
    await drain

    // Atomic replace
    fs.renameSync(tempPath, mainPath)
    fs.unlinkSync(repairPath)
    log('REPAIR', `[local] Merged ${blocks.size} blocks into ${rootCid.slice(0, 24)}...`)
  }

  async close(): Promise<void> {
    for (const rootCid of [...this.repairWriters.keys()]) {
      await this.closeRepairWriter(rootCid)
    }
  }

  async closeRepairWriter(rootCid: string): Promise<void> {
    const entry = this.repairWriters.get(rootCid)
    if (!entry) return
    await entry.writer.close()
    await entry.drainPromise
    this.repairWriters.delete(rootCid)
  }

  private carPath(rootCid: string): string {
    return path.join(this.outputDir, `${rootCid}.car`)
  }
}

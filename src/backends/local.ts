import fs from 'node:fs'
import path from 'node:path'
import { CarWriter, CarBlockIterator } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { ExportBackend } from './interface.js'
import type { BlockStream, Block } from '../core/blocks.js'
import type { BlockManifest } from '../core/manifest.js'
import { log } from '../util/log.js'

export class LocalBackend implements ExportBackend {
  name = 'local' as const

  constructor(private options: { outputDir: string }) {}

  get outputDir() { return this.options.outputDir }

  async init(): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true })
  }

  async hasContent(rootCid: string): Promise<boolean> {
    return fs.existsSync(this.carPath(rootCid))
  }

  async importCar(rootCid: string, blocks: BlockStream): Promise<void> {
    fs.mkdirSync(this.outputDir, { recursive: true })
    const rootCidObj = CID.parse(rootCid)
    const { writer, out } = CarWriter.create([rootCidObj])

    const chunks: Uint8Array[] = []
    const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()

    for await (const block of blocks) {
      await writer.put(block)
    }
    await writer.close()
    await drain

    fs.writeFileSync(this.carPath(rootCid), Buffer.concat(chunks))
  }

  async getContentSize(rootCid: string): Promise<number | null> {
    const filePath = this.carPath(rootCid)
    try {
      return fs.statSync(filePath).size
    } catch {
      return null
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
      let count = 0
      for await (const _ of iterator) count++
      return count > 0 ? { valid: true } : { valid: false, error: 'Empty CAR' }
    } catch (err: any) {
      return { valid: false, error: err.message }
    }
  }

  async repair(
    rootCid: string,
    manifest: BlockManifest,
    fetchBlock: (cid: string) => Promise<Block>,
  ): Promise<boolean> {
    const filePath = this.carPath(rootCid)
    if (!fs.existsSync(filePath)) {
      log('REPAIR', `[local] No CAR file on disk for ${rootCid.slice(0, 24)}...`)
      return false
    }

    if (!manifest.isRepairable(rootCid)) {
      log('REPAIR', `[local] Not repairable — missing DAG-PB nodes`)
      return false
    }

    const missing = manifest.getMissing(rootCid)
    if (missing.length === 0) return true

    log('REPAIR', `[local] ${missing.length} missing blocks — fetching and rewriting CAR`)

    const existingBlocks: Block[] = []
    try {
      const stream = fs.createReadStream(filePath)
      const iterator = await CarBlockIterator.fromIterable(stream)
      for await (const block of iterator) {
        existingBlocks.push(block)
      }
    } catch {
      // Truncation — we got what we got
    }

    const fetchedBlocks: Block[] = []
    let failed = 0
    for (const row of missing) {
      try {
        const block = await fetchBlock(row.block_cid)
        fetchedBlocks.push(block)
        manifest.markSeen(rootCid, row.block_cid, row.codec)
      } catch (err: any) {
        log('REPAIR', `  FAIL ${row.block_cid.slice(0, 24)}...: ${err.message}`)
        failed++
      }
    }

    if (failed > 0) {
      log('REPAIR', `[local] ${failed} blocks could not be fetched`)
      return false
    }

    const tempPath = filePath + '.repair'
    const rootCidObj = CID.parse(rootCid)
    const { writer, out } = CarWriter.create([rootCidObj])

    const chunks: Uint8Array[] = []
    const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()

    for (const block of existingBlocks) await writer.put(block)
    for (const block of fetchedBlocks) await writer.put(block)
    await writer.close()
    await drain

    fs.writeFileSync(tempPath, Buffer.concat(chunks))
    fs.renameSync(tempPath, filePath)
    log('REPAIR', `[local] Wrote complete CAR: ${existingBlocks.length + fetchedBlocks.length} blocks`)
    return true
  }

  private carPath(rootCid: string): string {
    return path.join(this.outputDir, `${rootCid}.car`)
  }
}

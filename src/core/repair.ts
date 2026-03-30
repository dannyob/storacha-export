import * as dagPB from '@ipld/dag-pb'
import type { BlockManifest } from './manifest.js'
import type { Block } from './blocks.js'
import { log } from '../util/log.js'

export interface RepairResult {
  fetched: number
  skipped: number
  failed: number
  complete: boolean
  blocks: Block[]
}

export interface RepairOptions {
  onProgress?: (fetched: number, total: number, bytes: number) => void
  throttleMs?: number
}

/**
 * Repair a partial upload by fetching missing blocks.
 *
 * Returns null if nothing to repair or not repairable.
 * Returns RepairResult with the fetched blocks.
 */
export async function repairUpload(
  rootCid: string,
  manifest: BlockManifest,
  fetchBlock: (cidStr: string) => Promise<Block>,
  options: RepairOptions = {},
): Promise<RepairResult | null> {
  const { onProgress, throttleMs = 1000 } = options
  const tag = rootCid.slice(0, 24) + '...'

  let missing = manifest.getMissing(rootCid)
  if (missing.length === 0) {
    log('REPAIR', `[${tag}] No missing blocks`)
    return null
  }

  log('REPAIR', `[${tag}] ${missing.length} missing blocks — fetching`)

  const blocks: Block[] = []
  let skipped = 0
  let failed = 0
  let repairBytes = 0
  let totalFetched = 0

  // Iterative repair: fetch missing blocks, decode dag-pb to discover more, repeat
  let pass = 0
  while (missing.length > 0) {
    pass++
    if (pass > 1) log('REPAIR', `[${tag}] Pass ${pass}: ${missing.length} more missing blocks`)

    for (const row of missing) {
      try {
        if (totalFetched === 0) log('REPAIR', `  ${tag} fetching block 1: ${row.block_cid.slice(0, 20)}...`)
        const block = await fetchBlock(row.block_cid)
        blocks.push(block)
        totalFetched++
        repairBytes += block.bytes.length
        manifest.markSeen(rootCid, row.block_cid, row.codec)

        // If it's a dag-pb node, extract links to discover more blocks
        if (block.cid.code === 0x70) {
          try {
            const node = dagPB.decode(block.bytes)
            for (const link of node.Links) {
              manifest.addLink(rootCid, link.Hash.toString(), link.Hash.code, block.cid.toString())
            }
          } catch {}
        }

        const totalMissing = manifest.getProgress(rootCid).missing
        onProgress?.(totalFetched, totalFetched + totalMissing, repairBytes)
        log('REPAIR', `  ${tag} ${totalFetched} fetched (${totalMissing} remaining) ${row.block_cid.slice(0, 20)}... ${block.bytes.length} bytes`)
      } catch (err: any) {
        log('REPAIR', `  FAIL ${row.block_cid.slice(0, 24)}...: ${err.message}`)
        failed++
      }
      if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
    }

    // Check if decoding dag-pb blocks revealed more missing blocks
    missing = manifest.getMissing(rootCid)
    if (pass > 20) {
      log('REPAIR', `[${tag}] Too many passes (${pass}), stopping`)
      break
    }
  }

  if (skipped > 0) {
    log('REPAIR', `[${tag}] ${skipped} blocks already in backend`)
  }

  const complete = failed === 0
  log('REPAIR', `[${tag}] Repair: ${blocks.length} fetched, ${skipped} skipped, ${failed} failed`)

  return { fetched: blocks.length, skipped, failed, complete, blocks }
}

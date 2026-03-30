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
  hasBlock?: (cid: string) => Promise<boolean>
  onProgress?: (fetched: number, total: number, bytes: number) => void
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
  const { hasBlock, onProgress } = options
  const tag = rootCid.slice(0, 24) + '...'

  const missing = manifest.getMissing(rootCid)
  if (missing.length === 0) {
    log('REPAIR', `[${tag}] No missing blocks`)
    return null
  }

  const missingDagPB = manifest.getMissingDagPB(rootCid)
  if (missingDagPB.length > 0) {
    log('REPAIR', `[${tag}] Cannot repair: ${missingDagPB.length} missing DAG-PB node(s)`)
    return null
  }

  log('REPAIR', `[${tag}] ${missing.length} missing blocks — fetching`)

  const blocks: Block[] = []
  let skipped = 0
  let failed = 0
  let repairBytes = 0

  for (const [i, row] of missing.entries()) {
    // Check if backend already has this block
    if (hasBlock) {
      try {
        if (i === 0) log('REPAIR', `  ${tag} checking backend for block 1/${missing.length}...`)
        if (await hasBlock(row.block_cid)) {
          skipped++
          manifest.markSeen(rootCid, row.block_cid, row.codec)
          if (skipped % 100 === 0) log('REPAIR', `  ${tag} ${skipped} skipped (backend has them)`)
          continue
        }
      } catch { /* couldn't check, fetch it */ }
    }

    try {
      if (blocks.length === 0 && failed === 0) log('REPAIR', `  ${tag} fetching block 1: ${row.block_cid.slice(0, 20)}...`)
      const block = await fetchBlock(row.block_cid)
      blocks.push(block)
      repairBytes += block.bytes.length
      manifest.markSeen(rootCid, row.block_cid, row.codec)
      onProgress?.(blocks.length, missing.length, repairBytes)
      log('REPAIR', `  ${tag} ${blocks.length}/${missing.length} ${row.block_cid.slice(0, 20)}... ${block.bytes.length} bytes`)
    } catch (err: any) {
      log('REPAIR', `  FAIL ${row.block_cid.slice(0, 24)}...: ${err.message}`)
      failed++
    }
  }

  if (skipped > 0) {
    log('REPAIR', `[${tag}] ${skipped} blocks already in backend`)
  }

  const complete = failed === 0
  log('REPAIR', `[${tag}] Repair: ${blocks.length} fetched, ${skipped} skipped, ${failed} failed`)

  return { fetched: blocks.length, skipped, failed, complete, blocks }
}

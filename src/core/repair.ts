import * as dagPB from '@ipld/dag-pb'
import type { BlockManifest } from './manifest.js'
import type { Block } from './blocks.js'
import { log } from '../util/log.js'

export interface RepairResult {
  fetched: number
  failed: number
  complete: boolean
}

export interface RepairOptions {
  onProgress?: (fetched: number, total: number, bytes: number) => void
  onBlock?: (block: Block) => Promise<void>
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
  const { onProgress, onBlock, throttleMs = 1000 } = options
  const tag = rootCid.slice(0, 24) + '...'

  let missing = manifest.getMissing(rootCid)
  if (missing.length === 0) {
    log('REPAIR', `[${tag}] No missing blocks`)
    return null
  }

  const initialProgress = manifest.getProgress(rootCid)
  log('REPAIR', `[${tag}] ${initialProgress.seen}/${initialProgress.total} seen, ${missing.length} missing — fetching`)

  let totalFetched = 0
  let failed = 0
  let repairBytes = 0

  // Iterative repair: fetch missing blocks, decode dag-pb to discover more, repeat
  let pass = 0
  while (missing.length > 0) {
    pass++
    if (pass > 1) log('REPAIR', `[${tag}] Pass ${pass}: ${missing.length} more missing blocks`)

    let progressThisPass = false
    const BATCH_SIZE = 3
    let consecutiveFailBatches = 0

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE)

      const results = await Promise.allSettled(batch.map(async (row) => {
        const block = await fetchBlock(row.block_cid)
        return { block, row }
      }))

      for (const [j, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          const { block, row } = result.value
          totalFetched++
          progressThisPass = true
          repairBytes += block.bytes.length
          manifest.markSeen(rootCid, row.block_cid, row.codec)

          if (onBlock) await onBlock(block)

          if (block.cid.code === 0x70) {
            try {
              const node = dagPB.decode(block.bytes)
              for (const link of node.Links) {
                manifest.addLink(rootCid, link.Hash.toString(), link.Hash.code, block.cid.toString())
              }
            } catch {}
          }
        } else {
          log('REPAIR', `  FAIL ${batch[j].block_cid.slice(0, 24)}...: ${result.reason?.message}`)
          failed++
        }
      }

      // Track consecutive failed batches for backoff
      const batchSuccesses = results.filter(r => r.status === 'fulfilled').length
      if (batchSuccesses === 0) {
        consecutiveFailBatches++
        if (consecutiveFailBatches >= 3) {
          const backoff = Math.min(30000, 5000 * consecutiveFailBatches)
          log('REPAIR', `  ${tag} ${consecutiveFailBatches} failed batches in a row, backing off ${backoff / 1000}s`)
          await new Promise(r => setTimeout(r, backoff))
        }
      } else {
        consecutiveFailBatches = 0
      }

      const progress = manifest.getProgress(rootCid)
      onProgress?.(progress.seen, progress.total, repairBytes)
      if ((i + BATCH_SIZE) % 50 < BATCH_SIZE) {
        log('REPAIR', `  ${tag} ${progress.seen}/${progress.total} blocks seen (${progress.missing} remaining, +${totalFetched} this session)`)
      }

      if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
    }

    // Check if decoding dag-pb blocks revealed more missing blocks
    missing = manifest.getMissing(rootCid)

    // Stop if no progress was made this pass (all remaining blocks are unfetchable)
    if (!progressThisPass) {
      log('REPAIR', `[${tag}] No progress in pass ${pass}, stopping`)
      break
    }
    if (pass > 50) {
      log('REPAIR', `[${tag}] Too many passes (${pass}), stopping`)
      break
    }
  }

  const remaining = manifest.getMissing(rootCid).length
  const complete = failed === 0 && remaining === 0
  log('REPAIR', `[${tag}] Repair: ${totalFetched} fetched, ${failed} failed, ${remaining} remaining`)

  return { fetched: totalFetched, failed, complete }
}

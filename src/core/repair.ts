import * as dagPB from '@ipld/dag-pb'
import type { BlockManifest } from './manifest.js'
import type { Block, BlockStream } from './blocks.js'
import { log } from '../util/log.js'
import { formatEta } from '../util/format.js'

export interface RepairResult {
  fetched: number
  failed: number
  complete: boolean
}

export interface RepairOptions {
  onProgress?: (fetched: number, total: number, bytes: number) => void
  onBlock?: (block: Block) => Promise<void>
  fetchSubCar?: (cid: string) => Promise<BlockStream>
  throttleMs?: number
  batchSize?: number
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
  const { onProgress, onBlock, fetchSubCar, throttleMs = 1000, batchSize = 5 } = options
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
  const startTime = Date.now()

  // Helper: process a fetched block — mark seen, push to backend, extract links
  async function processBlock(block: Block): Promise<void> {
    const cidStr = block.cid.toString()
    manifest.markSeen(rootCid, cidStr, block.cid.code)
    totalFetched++
    repairBytes += block.bytes.length
    if (onBlock) await onBlock(block)

    if (block.cid.code === 0x70) {
      try {
        const node = dagPB.decode(block.bytes)
        for (const link of node.Links) {
          manifest.addLink(rootCid, link.Hash.toString(), link.Hash.code, cidStr)
        }
      } catch {}
    }
  }

  // Phase 1: Fetch missing dag-pb nodes as sub-CARs (gets whole subtrees per request)
  if (fetchSubCar) {
    const missingDagPB = missing.filter(r => r.codec === 0x70)
    if (missingDagPB.length > 0) {
      log('REPAIR', `[${tag}] Fetching ${missingDagPB.length} dag-pb nodes as sub-CARs`)

      for (const row of missingDagPB) {
        if (manifest.isSeen(rootCid, row.block_cid)) continue

        try {
          const stream = await fetchSubCar(row.block_cid)
          let subBlocks = 0
          for await (const block of stream) {
            if (!manifest.isSeen(rootCid, block.cid.toString())) {
              await processBlock(block)
              subBlocks++
            }
          }
          if (subBlocks > 0) {
            log('REPAIR', `[${tag}] sub-CAR ${row.block_cid.slice(0, 20)}... yielded ${subBlocks} blocks`)
          }
        } catch (err: any) {
          log('REPAIR', `[${tag}] sub-CAR ${row.block_cid.slice(0, 20)}... failed: ${err.message}`)
        }

        if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
      }

      const afterCars = manifest.getProgress(rootCid)
      log('REPAIR', `[${tag}] After sub-CARs: ${afterCars.seen}/${afterCars.total} seen, ${afterCars.missing} remaining`)
      onProgress?.(afterCars.seen, afterCars.total, repairBytes)
    }
  }

  // Phase 2: Fetch remaining missing blocks individually
  missing = manifest.getMissing(rootCid)

  let pass = 0
  while (missing.length > 0) {
    pass++
    if (pass > 1) log('REPAIR', `[${tag}] Pass ${pass}: ${missing.length} more missing blocks`)

    let progressThisPass = false
    const BATCH_SIZE = batchSize
    let consecutiveFailBatches = 0

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE)

      const results = await Promise.allSettled(batch.map(async (row) => {
        const block = await fetchBlock(row.block_cid)
        return { block, row }
      }))

      for (const [j, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          await processBlock(result.value.block)
          progressThisPass = true
        } else {
          log('REPAIR', `  FAIL ${batch[j].block_cid.slice(0, 24)}...: ${result.reason?.message}`)
          failed++
        }
      }

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

      if ((i + BATCH_SIZE) % 50 < BATCH_SIZE) {
        const progress = manifest.getProgress(rootCid)
        onProgress?.(progress.seen, progress.total, repairBytes)
        const elapsed = (Date.now() - startTime) / 1000
        const rate = totalFetched > 0 ? totalFetched / elapsed : 0
        const eta = rate > 0 ? formatEta(Math.round(progress.missing / rate)) : ''
        log('REPAIR', `  ${tag} ${progress.seen}/${progress.total} blocks (${progress.missing} remaining, +${totalFetched} this session${eta ? `, ~${eta} left` : ''})`)
      }

      if (throttleMs > 0) await new Promise(r => setTimeout(r, throttleMs))
    }

    missing = manifest.getMissing(rootCid)

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

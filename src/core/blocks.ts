import { CID } from 'multiformats/cid'
import { CarBlockIterator } from '@ipld/car'
import { Readable } from 'node:stream'
import * as dagPB from '@ipld/dag-pb'
import type { BlockManifest } from './manifest.js'

export interface Block {
  cid: CID
  bytes: Uint8Array
}

export type BlockStream = AsyncIterable<Block>

/**
 * Parse a CAR (as bytes or a ReadableStream) into a BlockStream.
 * Handles truncated CARs gracefully — yields blocks until truncation, then stops.
 */
export async function* carToBlockStream(source: Uint8Array | ReadableStream<Uint8Array>): BlockStream {
  let iterable: AsyncIterable<Uint8Array>
  if (source instanceof Uint8Array) {
    iterable = (async function* () { yield source })()
  } else {
    iterable = Readable.fromWeb(source as any) as AsyncIterable<Uint8Array>
  }

  const iterator = await CarBlockIterator.fromIterable(iterable)

  try {
    for await (const { cid, bytes } of iterator) {
      yield { cid, bytes }
    }
  } catch {
    // Truncated CAR — stop yielding, don't throw
  }
}

/**
 * Collect a BlockStream into an array (for testing).
 */
export async function blockStreamToArray(stream: BlockStream): Promise<Block[]> {
  const blocks: Block[] = []
  for await (const block of stream) {
    blocks.push(block)
  }
  return blocks
}

const DAG_PB_CODE = 0x70

/**
 * Transform a BlockStream to record each block in the manifest.
 * Extracts links from dag-pb nodes so we know what blocks exist in the DAG.
 * Yields all blocks unchanged.
 */
export async function* trackBlocks(
  source: BlockStream,
  rootCid: string,
  manifest: BlockManifest,
): BlockStream {
  for await (const block of source) {
    const cidStr = block.cid.toString()

    // Record this block as seen
    manifest.markSeen(rootCid, cidStr, block.cid.code)

    // If it's a dag-pb node, extract its links
    if (block.cid.code === DAG_PB_CODE) {
      try {
        const node = dagPB.decode(block.bytes)
        for (const link of node.Links) {
          manifest.addLink(rootCid, link.Hash.toString(), link.Hash.code, cidStr)
        }
      } catch {
        // Malformed dag-pb — skip link extraction
      }
    }

    yield block
  }
}

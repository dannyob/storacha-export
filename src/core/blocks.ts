import { CID } from 'multiformats/cid'
import { CarBlockIterator } from '@ipld/car'
import { Readable } from 'node:stream'

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

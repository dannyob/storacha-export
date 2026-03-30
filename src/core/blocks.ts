import { CID } from 'multiformats/cid'

export interface Block {
  cid: CID
  bytes: Uint8Array
}

export type BlockStream = AsyncIterable<Block>

import type { BlockStream } from '../core/blocks.js'

export interface ExportBackend {
  name: string

  init?(): Promise<void>
  close?(): Promise<void>

  /** Import CAR data — accepts raw CAR byte stream or a BlockStream */
  importCar(rootCid: string, stream: BlockStream | AsyncIterable<Uint8Array> | NodeJS.ReadableStream): Promise<void>

  /** Cheap existence/pinning check */
  hasContent?(rootCid: string): Promise<boolean>

  /** Check if an individual block exists in the store */
  hasBlock?(cid: string): Promise<boolean>

  /** Store an individual block (rootCid identifies which upload this belongs to) */
  putBlock?(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void>

  /** Remove existing content for a root (e.g. before shard re-import) */
  clearContent?(rootCid: string): Promise<void>

  /** Import a single shard CAR by index (avoids merge overhead) */
  importShardCar?(rootCid: string, shardIndex: number, stream: AsyncIterable<Uint8Array>): Promise<void>

  /** Pin a root CID (e.g. after importing shards whose CAR roots differ from the upload root) */
  pinRoot?(rootCid: string): Promise<void>

  /** Deep verification — check that the full DAG is traversable */
  verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }>
}

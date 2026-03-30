import type { BlockStream, Block } from '../core/blocks.js'
import type { BlockManifest } from '../core/manifest.js'

export interface ExportBackend {
  name: string

  init?(): Promise<void>
  close?(): Promise<void>

  /** Import CAR data — accepts raw CAR byte stream or a BlockStream */
  importCar(rootCid: string, stream: BlockStream | AsyncIterable<Uint8Array> | NodeJS.ReadableStream): Promise<void>

  /** Check if a root CID is fully stored (pinned) */
  hasContent(rootCid: string): Promise<boolean>

  /** Check if an individual block exists in the store */
  hasBlock?(cid: string): Promise<boolean>

  /** Store an individual block */
  putBlock?(cid: string, bytes: Uint8Array): Promise<void>

  /** Override repair strategy entirely */
  repair?(rootCid: string, manifest: BlockManifest, fetchBlock: (cid: string) => Promise<Block>): Promise<boolean>

  /** Get the total size of a DAG in bytes (if available) */
  getContentSize?(rootCid: string): Promise<number | null>

  /** Deep verification — check that the full DAG is traversable */
  verifyDag?(rootCid: string): Promise<{ valid: boolean; error?: string }>
}

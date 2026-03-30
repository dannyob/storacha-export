import type { BlockStream, Block } from '../core/blocks.js'
import type { BlockManifest } from '../core/manifest.js'

export interface ExportBackend {
  name: string

  init?(): Promise<void>
  close?(): Promise<void>

  /** Import a stream of blocks (happy path — from a CAR) */
  importCar(rootCid: string, blocks: BlockStream): Promise<void>

  /** Check if a root CID is fully stored (pinned) */
  hasContent(rootCid: string): Promise<boolean>

  /** Check if an individual block exists in the store */
  hasBlock?(cid: string): Promise<boolean>

  /** Store an individual block */
  putBlock?(cid: string, bytes: Uint8Array): Promise<void>

  /** Override repair strategy entirely */
  repair?(rootCid: string, manifest: BlockManifest, fetchBlock: (cid: string) => Promise<Block>): Promise<boolean>

  /** Deep verification — check that the full DAG is traversable */
  verifyDag?(rootCid: string): Promise<{ valid: boolean; error?: string }>
}

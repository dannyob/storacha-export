import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { ExportBackend } from './interface.js'
import type { BlockStream } from '../core/blocks.js'

export class ClusterBackend implements ExportBackend {
  name = 'cluster' as const
  apiUrl: string

  constructor(options: { apiUrl: string }) {
    this.apiUrl = options.apiUrl.replace(/\/$/, '')
  }

  async init(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/id`)
    if (!res.ok) throw new Error(`Cannot connect to IPFS Cluster at ${this.apiUrl}: ${res.status}`)
  }

  async importCar(rootCid: string, blocks: BlockStream): Promise<void> {
    const rootCidObj = CID.parse(rootCid)
    const { writer, out } = CarWriter.create([rootCidObj])

    const chunks: Uint8Array[] = []
    const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()

    for await (const block of blocks) await writer.put(block)
    await writer.close()
    await drain

    const carBlob = new Blob(chunks, { type: 'application/vnd.ipld.car' })
    const form = new FormData()
    form.append('file', carBlob, `${rootCid}.car`)

    const res = await fetch(`${this.apiUrl}/add?format=car`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Cluster add failed (${res.status}): ${text}`)
    }
    await res.text()
  }

  async hasContent(rootCid: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/pins/${rootCid}`)
      if (!res.ok) return false
      const data = await res.json() as { peer_map?: Record<string, { status: string }> }
      const statuses = Object.values(data.peer_map || {})
      return statuses.some(s => s.status === 'pinned')
    } catch {
      return false
    }
  }

  async hasBlock(cid: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v0/block/stat?arg=${cid}`, { method: 'POST' })
      return res.ok
    } catch {
      return false
    }
  }
}

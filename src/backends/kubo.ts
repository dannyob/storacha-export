import { Readable } from 'node:stream'
import { CarWriter } from '@ipld/car'
import { CID } from 'multiformats/cid'
import type { ExportBackend } from './interface.js'
import type { BlockStream, Block } from '../core/blocks.js'
import type { BlockManifest } from '../core/manifest.js'

const BOUNDARY = '----StorachaExportBoundary'

function multipartStream(fieldName: string, filename: string, carStream: AsyncIterable<Uint8Array>): Readable {
  const preamble = Buffer.from(
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: application/vnd.ipld.car\r\n` +
    `\r\n`
  )
  const epilogue = Buffer.from(`\r\n--${BOUNDARY}--\r\n`)

  async function* generate() {
    yield preamble
    for await (const chunk of carStream) yield chunk
    yield epilogue
  }

  return Readable.from(generate())
}

function parseApiUrl(input: string): string {
  const match = input.match(/^\/ip4\/([^/]+)\/tcp\/(\d+)/)
  if (match) return `http://${match[1]}:${match[2]}`
  return input.replace(/\/$/, '')
}

export class KuboBackend implements ExportBackend {
  name = 'kubo' as const
  apiUrl: string

  constructor(options: { apiUrl: string }) {
    this.apiUrl = parseApiUrl(options.apiUrl)
  }

  async init(): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/v0/id`, { method: 'POST' })
    if (!res.ok) throw new Error(`Cannot connect to kubo at ${this.apiUrl}: ${res.status}`)
  }

  async importCar(rootCid: string, blocks: BlockStream): Promise<void> {
    // Convert BlockStream back to a CAR for dag/import
    const rootCidObj = CID.parse(rootCid)
    const { writer, out } = CarWriter.create([rootCidObj])

    // Stream the CAR through multipart to kubo
    const carChunks = (async function* () {
      for await (const chunk of out) yield chunk
    })()
    const body = multipartStream('file', `${rootCid}.car`, carChunks)

    // Feed blocks into the writer in parallel with the upload
    const writePromise = (async () => {
      for await (const block of blocks) {
        await writer.put(block)
      }
      await writer.close()
    })()

    const res = await fetch(`${this.apiUrl}/api/v0/dag/import?pin-roots=true`, {
      method: 'POST',
      body: body as any,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      duplex: 'half',
    } as any)

    await writePromise

    if (!res.ok) {
      const text = await res.text()
      throw new Error(`kubo dag/import failed (${res.status}): ${text}`)
    }

    // Check for pin errors in ndjson response
    const text = await res.text()
    for (const line of text.trim().split('\n').filter(Boolean)) {
      try {
        const result = JSON.parse(line)
        if (result.Root?.PinErrorMsg) {
          throw new Error(`Pin failed: ${result.Root.PinErrorMsg}`)
        }
      } catch (e: any) {
        if (e.message.startsWith('Pin failed')) throw e
      }
    }
  }

  async hasContent(rootCid: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v0/pin/ls?arg=${rootCid}&type=recursive`, { method: 'POST' })
      if (!res.ok) return false
      const data = await res.json() as { Keys?: Record<string, unknown> }
      return rootCid in (data.Keys || {})
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

  async putBlock(cid: string, bytes: Uint8Array): Promise<void> {
    const form = new FormData()
    form.append('file', new Blob([bytes as Uint8Array<ArrayBuffer>]), cid)
    const res = await fetch(`${this.apiUrl}/api/v0/block/put?cid-codec=raw`, {
      method: 'POST',
      body: form,
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`block/put failed (${res.status}): ${text}`)
    }
    await res.text()
  }

  async getContentSize(rootCid: string): Promise<number | null> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v0/dag/stat?arg=${rootCid}`, { method: 'POST' })
      if (!res.ok) return null
      const data = await res.json() as { Size?: number }
      return data.Size ?? null
    } catch {
      return null
    }
  }

  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.apiUrl}/api/v0/dag/stat?arg=${rootCid}`, { method: 'POST' })
      if (!res.ok) {
        const text = await res.text()
        return { valid: false, error: `dag/stat failed: ${text}` }
      }
      return { valid: true }
    } catch (err: any) {
      return { valid: false, error: err.message }
    }
  }
}

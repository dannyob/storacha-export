import { Readable } from 'node:stream'
import type { ExportBackend } from './interface.js'
import type { BlockStream } from '../core/blocks.js'

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

  async importCar(rootCid: string, stream: BlockStream | AsyncIterable<Uint8Array> | NodeJS.ReadableStream): Promise<void> {
    // Stream directly to kubo — accepts raw CAR bytes or a BlockStream
    const body = multipartStream('file', `${rootCid}.car`, stream as AsyncIterable<Uint8Array>)

    const res = await fetch(`${this.apiUrl}/api/v0/dag/import?pin-roots=true`, {
      method: 'POST',
      body: body as any,
      headers: { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` },
      duplex: 'half',
    } as any)

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

  async putBlock(cid: string, bytes: Uint8Array, _rootCid?: string): Promise<void> {
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

  async pinRoot(rootCid: string): Promise<void> {
    const res = await fetch(`${this.apiUrl}/api/v0/pin/add?arg=${rootCid}`, { method: 'POST' })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`pin/add failed (${res.status}): ${text}`)
    }
    await res.text()
  }

  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(`${this.apiUrl}/api/v0/dag/stat?arg=${rootCid}`, {
        method: 'POST',
        signal: controller.signal,
      })
      if (!res.ok) {
        clearTimeout(timer)
        const text = await res.text()
        return { valid: false, error: `dag/stat failed: ${text}` }
      }
      // dag/stat streams the response as it traverses the DAG — for large DAGs
      // this can take minutes. Cancel the body once we know it's 200 OK.
      clearTimeout(timer)
      await res.body?.cancel()
      return { valid: true }
    } catch (err: any) {
      return { valid: false, error: err.message }
    }
  }
}

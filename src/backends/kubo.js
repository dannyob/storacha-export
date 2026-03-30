import { Readable, PassThrough } from 'node:stream'

const BOUNDARY = '----StorachaExportBoundary'

/**
 * Build a streaming multipart body without buffering.
 * Yields: preamble, then pipes the CAR stream, then yields epilogue.
 */
function multipartStream(fieldName, filename, carStream) {
  const preamble = Buffer.from(
    `--${BOUNDARY}\r\n` +
    `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
    `Content-Type: application/vnd.ipld.car\r\n` +
    `\r\n`
  )
  const epilogue = Buffer.from(`\r\n--${BOUNDARY}--\r\n`)

  // Use an async generator to properly respect backpressure:
  // the consumer (fetch) pulls chunks only as fast as it can send them,
  // which in turn applies backpressure to the carStream.
  async function* generate() {
    yield preamble
    for await (const chunk of carStream) {
      yield chunk
    }
    yield epilogue
  }

  return Readable.from(generate())
}

export class KuboBackend {
  constructor({ apiUrl }) {
    this.name = 'kubo'
    this.apiUrl = parseApiUrl(apiUrl)
  }

  async init() {
    // Verify connectivity
    const res = await fetch(`${this.apiUrl}/api/v0/id`, { method: 'POST' })
    if (!res.ok) {
      throw new Error(`Cannot connect to kubo at ${this.apiUrl}: ${res.status}`)
    }
  }

  async hasContent(rootCid) {
    try {
      const res = await fetch(
        `${this.apiUrl}/api/v0/pin/ls?arg=${rootCid}&type=recursive`,
        { method: 'POST' }
      )
      if (!res.ok) return false
      const data = await res.json()
      return rootCid in (data.Keys || {})
    } catch {
      return false
    }
  }

  async hasBlock(cid) {
    try {
      const res = await fetch(
        `${this.apiUrl}/api/v0/block/stat?arg=${cid}`,
        { method: 'POST' }
      )
      return res.ok
    } catch {
      return false
    }
  }

  async importCar(rootCid, stream) {
    // Stream multipart form data without buffering the entire CAR
    const body = multipartStream('file', `${rootCid}.car`, stream)

    const res = await fetch(`${this.apiUrl}/api/v0/dag/import?pin-roots=true`, {
      method: 'POST',
      body: body,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${BOUNDARY}`,
      },
      duplex: 'half',
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`kubo dag/import failed (${res.status}): ${text}`)
    }
    // dag/import returns ndjson with root pin status — check for errors
    const text = await res.text()
    for (const line of text.trim().split('\n').filter(Boolean)) {
      try {
        const result = JSON.parse(line)
        if (result.Root?.PinErrorMsg) {
          throw new Error(`Pin failed for ${rootCid}: ${result.Root.PinErrorMsg}`)
        }
      } catch (e) {
        if (e.message.startsWith('Pin failed')) throw e
      }
    }
  }

  async close() {}
}

function parseApiUrl(input) {
  // Handle multiaddr format: /ip4/127.0.0.1/tcp/5001
  const match = input.match(/^\/ip4\/([^/]+)\/tcp\/(\d+)/)
  if (match) {
    return `http://${match[1]}:${match[2]}`
  }
  // Already a URL
  return input.replace(/\/$/, '')
}

import { Readable } from 'node:stream'

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

  async importCar(rootCid, stream) {
    // Convert Node readable to a fetch-compatible body
    const res = await fetch(`${this.apiUrl}/api/v0/dag/import?pin-roots=true`, {
      method: 'POST',
      body: stream,
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
      duplex: 'half',
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`kubo dag/import failed (${res.status}): ${text}`)
    }
    // dag/import returns ndjson — consume it
    await res.text()
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

export class ClusterBackend {
  constructor({ apiUrl }) {
    this.name = 'cluster'
    this.apiUrl = apiUrl.replace(/\/$/, '')
  }

  async init() {
    const res = await fetch(`${this.apiUrl}/id`)
    if (!res.ok) {
      throw new Error(`Cannot connect to IPFS Cluster at ${this.apiUrl}: ${res.status}`)
    }
  }

  async hasContent(rootCid) {
    try {
      const res = await fetch(`${this.apiUrl}/pins/${rootCid}`)
      if (!res.ok) return false
      const data = await res.json()
      // Cluster pin statuses: pinned, pinning, pin_error, etc.
      const statuses = Object.values(data.peer_map || {})
      return statuses.some(s => s.status === 'pinned')
    } catch {
      return false
    }
  }

  async importCar(rootCid, stream) {
    const res = await fetch(`${this.apiUrl}/add?format=car`, {
      method: 'POST',
      body: stream,
      headers: { 'Content-Type': 'application/vnd.ipld.car' },
      duplex: 'half',
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`Cluster add failed (${res.status}): ${text}`)
    }
    await res.text()
  }

  async close() {}
}

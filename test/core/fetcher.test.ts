import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { GatewayFetcher } from '../../src/core/fetcher.js'
import { blockStreamToArray } from '../../src/core/blocks.js'
import http from 'node:http'
import { buildCarBytes, makeRawBlock, makeDagPBNode } from './blocks.test.js'

describe('GatewayFetcher', () => {
  let server: http.Server
  let serverUrl: string
  let carBytes: Uint8Array
  let rootCidStr: string

  beforeEach(async () => {
    const leaf1 = await makeRawBlock('test-data-1')
    const leaf2 = await makeRawBlock('test-data-2')
    const root = await makeDagPBNode([leaf1, leaf2])
    rootCidStr = root.cid.toString()
    carBytes = await buildCarBytes([root, leaf1, leaf2], [root])

    server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      if (url.pathname.includes('/ipfs/') && url.searchParams.get('format') === 'car') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
        res.end(carBytes)
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    serverUrl = `http://127.0.0.1:${(server.address() as any).port}`
  })

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('fetches a CAR and returns a BlockStream', async () => {
    const fetcher = new GatewayFetcher(serverUrl)
    const stream = await fetcher.fetchCar(rootCidStr)
    const blocks = await blockStreamToArray(stream)
    expect(blocks).toHaveLength(3)
  })

  it('shares rate-limit backoff across concurrent fetches', async () => {
    const otherLeaf = await makeRawBlock('other-data')
    const otherRoot = await makeDagPBNode([otherLeaf])
    const otherCarBytes = await buildCarBytes([otherRoot, otherLeaf], [otherRoot])

    const originalFetch = globalThis.fetch
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.useFakeTimers()

    let firstRateLimited = false
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      const cid = url.pathname.match(/\/ipfs\/([^?]+)/)?.[1]

      if (cid === rootCidStr && !firstRateLimited) {
        firstRateLimited = true
        return new Response('slow down', {
          status: 429,
          headers: { 'retry-after': '1' },
        })
      }

      if (cid === rootCidStr) {
        return new Response(carBytes, {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.ipld.car' },
        })
      }

      if (cid === otherRoot.cid.toString()) {
        return new Response(otherCarBytes, {
          status: 200,
          headers: { 'Content-Type': 'application/vnd.ipld.car' },
        })
      }

      return new Response('not found', { status: 404 })
    }) as any

    const fetcher = new GatewayFetcher('http://gateway.test')

    try {
      const first = fetcher.fetchCar(rootCidStr)
      await vi.advanceTimersByTimeAsync(0)

      const second = fetcher.fetchCar(otherRoot.cid.toString())
      await vi.advanceTimersByTimeAsync(0)

      expect(globalThis.fetch).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(1000)

      const [firstStream, secondStream] = await Promise.all([first, second])
      const [firstBlocks, secondBlocks] = await Promise.all([
        blockStreamToArray(firstStream),
        blockStreamToArray(secondStream),
      ])

      expect(firstBlocks).toHaveLength(3)
      expect(secondBlocks).toHaveLength(2)
      expect(globalThis.fetch).toHaveBeenCalledTimes(3)
    } finally {
      globalThis.fetch = originalFetch
      randomSpy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('fetches a shard and returns a Response', async () => {
    const leaf = await makeRawBlock('shard-data')
    const shardCar = await buildCarBytes([leaf], [leaf])

    const rawServer = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      if (url.searchParams.get('format') === 'raw') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        res.end(shardCar)
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise<void>(resolve => rawServer.listen(0, resolve))
    const rawUrl = `http://127.0.0.1:${(rawServer.address() as any).port}`

    try {
      const fetcher = new GatewayFetcher(rawUrl)
      const res = await fetcher.fetchShard(leaf.cid.toString())
      expect(res.ok).toBe(true)
      const bytes = new Uint8Array(await res.arrayBuffer())
      expect(bytes.length).toBe(shardCar.length)
    } finally {
      await new Promise<void>(resolve => rawServer.close(() => resolve()))
    }
  })
})

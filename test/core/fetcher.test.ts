import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
})

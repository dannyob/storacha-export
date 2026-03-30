import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import { CarWriter, CarReader } from '@ipld/car'
import * as dagPB from '@ipld/dag-pb'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'

// Build test fixtures: a small DAG with a root (dag-pb) linking to 3 raw leaves

async function makeRawBlock(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, 0x55, hash) // raw codec
  return { cid, bytes }
}

async function makeDagPBNode(links) {
  const pbLinks = links.map((l, i) => ({
    Hash: l.cid,
    Name: `file-${i}`,
    Tsize: l.bytes.length,
  }))
  const bytes = dagPB.encode(dagPB.prepare({ Data: new Uint8Array([8, 1]), Links: pbLinks }))
  const hash = await sha256.digest(bytes)
  const cid = CID.create(1, 0x70, hash) // dag-pb codec
  return { cid, bytes }
}

async function buildTestCar(blocks, roots) {
  const { writer, out } = CarWriter.create(roots.map(b => b.cid))
  const chunks = []
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()
  for (const { cid, bytes } of blocks) await writer.put({ cid, bytes })
  await writer.close()
  await drain
  return Buffer.concat(chunks)
}

describe('repair', () => {
  let leaf1, leaf2, leaf3, root
  let completeCar, truncatedCar
  let server, serverUrl

  beforeEach(async () => {
    // Build a simple DAG: root -> [leaf1, leaf2, leaf3]
    leaf1 = await makeRawBlock('leaf-data-one-aaaa')
    leaf2 = await makeRawBlock('leaf-data-two-bbbb')
    leaf3 = await makeRawBlock('leaf-data-three-ccc')
    root = await makeDagPBNode([leaf1, leaf2, leaf3])

    // Complete CAR has all blocks
    completeCar = await buildTestCar([root, leaf1, leaf2, leaf3], [root])

    // Truncated CAR has root + leaf1 only (missing leaf2, leaf3)
    truncatedCar = await buildTestCar([root, leaf1], [root])

    // Mock server:
    // - /ipfs/<rootCid>?format=car → serves truncated CAR
    // - /<leafCid>.ipfs.w3s.link/?format=raw → serves raw leaf blocks
    const leafMap = new Map([
      [leaf1.cid.toString(), leaf1.bytes],
      [leaf2.cid.toString(), leaf2.bytes],
      [leaf3.cid.toString(), leaf3.bytes],
    ])

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`)

      // CAR request — serve truncated version
      if (url.pathname.includes('/ipfs/') && url.searchParams.get('format') === 'car') {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
        res.end(truncatedCar)
        return
      }

      // Raw block request — check host for CID
      const hostCid = req.headers.host?.split('.')[0]
      if (hostCid && url.searchParams.get('format') === 'raw' && leafMap.has(hostCid)) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.raw' })
        res.end(leafMap.get(hostCid))
        return
      }

      res.writeHead(404)
      res.end('not found')
    })
    await new Promise(resolve => server.listen(0, resolve))
    serverUrl = `http://127.0.0.1:${server.address().port}`
  })

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('complete CAR has all 4 blocks', async () => {
    const reader = await CarReader.fromBytes(new Uint8Array(completeCar))
    let count = 0
    for await (const _ of reader.blocks()) count++
    assert.equal(count, 4)
  })

  it('truncated CAR has only 2 blocks', async () => {
    const reader = await CarReader.fromBytes(new Uint8Array(truncatedCar))
    let count = 0
    for await (const _ of reader.blocks()) count++
    assert.equal(count, 2)
  })

  it('can identify missing blocks from truncated CAR', async () => {
    const reader = await CarReader.fromBytes(new Uint8Array(truncatedCar))
    const seen = new Set()
    const allLinks = []

    for await (const { cid, bytes } of reader.blocks()) {
      seen.add(cid.toString())
      if (cid.code === 0x70) {
        const node = dagPB.decode(bytes)
        for (const link of node.Links) {
          allLinks.push(link.Hash.toString())
        }
      }
    }

    const missing = allLinks.filter(l => !seen.has(l))
    assert.equal(missing.length, 2)
    assert.ok(missing.includes(leaf2.cid.toString()))
    assert.ok(missing.includes(leaf3.cid.toString()))
  })
})

import { JobQueue } from '../src/queue.js'

describe('queue: new methods', () => {
  const TEST_DB = '/tmp/storacha-export-repair-test.db'

  let queue

  beforeEach(() => {
    queue = new JobQueue(TEST_DB)
  })

  afterEach(() => {
    queue.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-journal') } catch {}
  })

  it('resetInProgress moves in_progress to pending', () => {
    queue.addJob({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.markInProgress('bafyA', 'kubo')
    assert.equal(queue.getPending('kubo').length, 0)

    const result = queue.resetInProgress()
    assert.equal(result.changes, 1)
    assert.equal(queue.getPending('kubo').length, 1)
  })

  it('getPendingCountForSpaces filters by space name', () => {
    queue.addJob({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'SpaceA', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk2', spaceName: 'SpaceB', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyC', spaceDid: 'did:key:z6Mk1', spaceName: 'SpaceA', backend: 'kubo' })

    assert.equal(queue.getPendingCountForSpaces(['SpaceA']), 2)
    assert.equal(queue.getPendingCountForSpaces(['SpaceB']), 1)
    assert.equal(queue.getPendingCountForSpaces(['SpaceA', 'SpaceB']), 3)
    assert.equal(queue.getPendingCountForSpaces(['SpaceC']), 0)
  })

  it('getTotalBytesTransferred sums done jobs', () => {
    queue.addJob({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.addJob({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.markDone('bafyA', 'kubo', 1000)
    queue.markDone('bafyB', 'kubo', 2000)
    assert.equal(queue.getTotalBytesTransferred(), 3000)
  })

  it('getErrors returns error details', () => {
    queue.addJob({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'kubo' })
    queue.markError('bafyA', 'kubo', 'fetch failed')
    const errors = queue.getErrors()
    assert.equal(errors.length, 1)
    assert.equal(errors[0].root_cid, 'bafyA')
    assert.equal(errors[0].error_msg, 'fetch failed')
  })
})

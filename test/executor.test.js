import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { executeJob, buildGatewayUrl } from '../src/executor.js'
import { JobQueue } from '../src/queue.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { LocalBackend } from '../src/backends/local.js'

const TEST_DB = '/tmp/storacha-export-exec-test.db'

describe('executor', () => {
  it('buildGatewayUrl constructs correct URL', () => {
    const url = buildGatewayUrl('bafytest123')
    assert.equal(url, 'https://w3s.link/ipfs/bafytest123?format=car')
  })

  it('buildGatewayUrl accepts custom gateway', () => {
    const url = buildGatewayUrl('bafytest123', 'https://my-gateway.example.com')
    assert.equal(url, 'https://my-gateway.example.com/ipfs/bafytest123?format=car')
  })

  describe('executeJob with mock server', () => {
    let server
    let serverUrl
    let tmpDir
    let queue

    beforeEach(async () => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-exec-'))
      queue = new JobQueue(TEST_DB)

      // Create a tiny HTTP server that serves fake CAR data
      server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
        res.end('fake-car-data-for-test')
      })
      await new Promise(resolve => server.listen(0, resolve))
      serverUrl = `http://127.0.0.1:${server.address().port}`
    })

    afterEach(async () => {
      queue.close()
      try { fs.unlinkSync(TEST_DB) } catch {}
      try { fs.unlinkSync(TEST_DB + '-journal') } catch {}
      fs.rmSync(tmpDir, { recursive: true, force: true })
      await new Promise(resolve => server.close(resolve))
    })

    it('downloads CAR and stores via backend', async () => {
      const backend = new LocalBackend({ outputDir: tmpDir })
      queue.addJob({
        rootCid: 'bafytest123',
        spaceDid: 'did:key:z6Mktest',
        spaceName: 'Test',
        backend: 'local'
      })

      await executeJob(
        { root_cid: 'bafytest123', backend: 'local' },
        [backend],
        queue,
        { gatewayUrl: serverUrl }
      )

      assert.equal(await backend.hasContent('bafytest123'), true)
      const stats = queue.getStats()
      assert.equal(stats.done, 1)
    })
  })
})

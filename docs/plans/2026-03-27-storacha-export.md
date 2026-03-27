# storacha-export Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Node.js CLI tool that exports Storacha space content to pluggable storage backends with streaming, resumability, and an interactive wizard.

**Architecture:** Job-queue model — enumerate uploads from Storacha into a SQLite queue, then execute transfers by streaming CAR data from the w3s.link gateway to pluggable backends. Progress tracked per (CID, backend) pair for resumability.

**Tech Stack:** Node.js (ESM), @storacha/client, better-sqlite3, commander, @inquirer/prompts, ora, cli-progress, pino

**Spec:** `docs/design.md`

**Credential location (macOS):** `~/Library/Preferences/w3access/storacha-cli.json` via `@storacha/client/stores/conf` with `StoreConf({ profile: 'storacha-cli' })`

---

## Chunk 1: Project Scaffolding + Queue

### Task 1: Project setup

**Files:**
- Create: `package.json`
- Create: `bin/storacha-export.js`
- Create: `.gitignore`

- [ ] **Step 1: Initialize the project**

```bash
cd ~/Private/filecoin/storacha-transition/storacha-export
npm init -y
```

Edit `package.json`:

```json
{
  "name": "storacha-export",
  "version": "0.1.0",
  "description": "Export Storacha space content to pluggable storage backends",
  "type": "module",
  "bin": {
    "storacha-export": "./bin/storacha-export.js"
  },
  "scripts": {
    "test": "node --test test/**/*.test.js",
    "start": "node bin/storacha-export.js"
  },
  "license": "AGPL-3.0-or-later",
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Install core dependencies**

```bash
npm install better-sqlite3 commander @inquirer/prompts ora cli-progress pino
npm install --save-dev @types/better-sqlite3
```

- [ ] **Step 3: Create .gitignore**

```
node_modules/
*.db
*.db-journal
```

- [ ] **Step 4: Create bin entry point**

Create `bin/storacha-export.js`:

```js
#!/usr/bin/env node
import { main } from '../src/cli.js'
main(process.argv)
```

Make executable:
```bash
chmod +x bin/storacha-export.js
```

- [ ] **Step 5: Create minimal src/cli.js placeholder**

```js
export function main(argv) {
  console.log('storacha-export: not yet implemented')
  process.exit(0)
}
```

- [ ] **Step 6: Verify it runs**

```bash
node bin/storacha-export.js
```

Expected: prints "storacha-export: not yet implemented"

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json bin/ src/cli.js .gitignore
git commit -m "chore: scaffold storacha-export project"
```

---

### Task 2: SQLite job queue

**Files:**
- Create: `src/queue.js`
- Create: `test/queue.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/queue.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { JobQueue } from '../src/queue.js'
import fs from 'node:fs'

const TEST_DB = '/tmp/storacha-export-test.db'

describe('JobQueue', () => {
  let queue

  beforeEach(() => {
    queue = new JobQueue(TEST_DB)
  })

  afterEach(() => {
    queue.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-journal') } catch {}
  })

  it('creates tables on init', () => {
    const tables = queue.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all().map(r => r.name)
    assert.ok(tables.includes('jobs'))
    assert.ok(tables.includes('spaces'))
  })

  it('adds jobs and retrieves pending', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    const pending = queue.getPending('local')
    assert.equal(pending.length, 1)
    assert.equal(pending[0].root_cid, 'bafytest1')
    assert.equal(pending[0].space_name, 'TestSpace')
  })

  it('skips duplicate jobs on insert', () => {
    const job = {
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    }
    queue.addJob(job)
    queue.addJob(job) // duplicate
    const pending = queue.getPending('local')
    assert.equal(pending.length, 1)
  })

  it('marks job done', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    queue.markDone('bafytest1', 'local', 12345)
    const pending = queue.getPending('local')
    assert.equal(pending.length, 0)
    const stats = queue.getStats()
    assert.equal(stats.done, 1)
  })

  it('marks job error', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    queue.markError('bafytest1', 'local', 'connection refused')
    const pending = queue.getPending('local')
    assert.equal(pending.length, 0)
    const stats = queue.getStats()
    assert.equal(stats.error, 1)
  })

  it('resets errored jobs for retry', () => {
    queue.addJob({
      rootCid: 'bafytest1',
      spaceDid: 'did:key:z6Mktest',
      spaceName: 'TestSpace',
      backend: 'local'
    })
    queue.markError('bafytest1', 'local', 'timeout')
    queue.resetErrors()
    const pending = queue.getPending('local')
    assert.equal(pending.length, 1)
  })

  it('records space info', () => {
    queue.upsertSpace({
      did: 'did:key:z6Mktest',
      name: 'TestSpace',
      totalUploads: 42,
      totalBytes: 1000000
    })
    const space = queue.getSpace('did:key:z6Mktest')
    assert.equal(space.name, 'TestSpace')
    assert.equal(space.total_uploads, 42)
  })

  it('reports progress stats', () => {
    queue.addJob({ rootCid: 'bafyA', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'local' })
    queue.addJob({ rootCid: 'bafyB', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'local' })
    queue.addJob({ rootCid: 'bafyC', spaceDid: 'did:key:z6Mk1', spaceName: 'S1', backend: 'local' })
    queue.markDone('bafyA', 'local', 500)
    queue.markError('bafyB', 'local', 'fail')
    const stats = queue.getStats()
    assert.equal(stats.total, 3)
    assert.equal(stats.done, 1)
    assert.equal(stats.error, 1)
    assert.equal(stats.pending, 1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test
```

Expected: fails with "Cannot find module '../src/queue.js'"

- [ ] **Step 3: Implement the queue**

Create `src/queue.js`:

```js
import Database from 'better-sqlite3'

export class JobQueue {
  constructor(dbPath = 'storacha-export.db') {
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this._createTables()
    this._prepareStatements()
  }

  _createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        root_cid TEXT NOT NULL,
        space_did TEXT NOT NULL,
        space_name TEXT,
        backend TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        error_msg TEXT,
        bytes_transferred INTEGER,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (root_cid, backend)
      );

      CREATE TABLE IF NOT EXISTS spaces (
        did TEXT PRIMARY KEY,
        name TEXT,
        total_uploads INTEGER,
        total_bytes INTEGER,
        enumerated_at TEXT
      );
    `)
  }

  _prepareStatements() {
    this._insertJob = this.db.prepare(`
      INSERT OR IGNORE INTO jobs (root_cid, space_did, space_name, backend)
      VALUES (@rootCid, @spaceDid, @spaceName, @backend)
    `)
    this._markDone = this.db.prepare(`
      UPDATE jobs SET status = 'done', bytes_transferred = @bytes,
        updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)
    this._markError = this.db.prepare(`
      UPDATE jobs SET status = 'error', error_msg = @errorMsg,
        updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)
    this._markInProgress = this.db.prepare(`
      UPDATE jobs SET status = 'in_progress', updated_at = datetime('now')
      WHERE root_cid = @rootCid AND backend = @backend
    `)
    this._getPending = this.db.prepare(`
      SELECT * FROM jobs WHERE backend = @backend AND status = 'pending'
    `)
    this._resetErrors = this.db.prepare(`
      UPDATE jobs SET status = 'pending', error_msg = NULL,
        updated_at = datetime('now')
      WHERE status = 'error'
    `)
    this._upsertSpace = this.db.prepare(`
      INSERT INTO spaces (did, name, total_uploads, total_bytes, enumerated_at)
      VALUES (@did, @name, @totalUploads, @totalBytes, datetime('now'))
      ON CONFLICT(did) DO UPDATE SET
        name = @name, total_uploads = @totalUploads, total_bytes = @totalBytes,
        enumerated_at = datetime('now')
    `)
    this._getSpace = this.db.prepare(`SELECT * FROM spaces WHERE did = @did`)
    this._getStats = this.db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as done,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress
      FROM jobs
    `)
  }

  addJob({ rootCid, spaceDid, spaceName, backend }) {
    this._insertJob.run({ rootCid, spaceDid, spaceName, backend })
  }

  addJobsBatch(jobs) {
    const insert = this.db.transaction((items) => {
      for (const job of items) {
        this._insertJob.run(job)
      }
    })
    insert(jobs)
  }

  markInProgress(rootCid, backend) {
    this._markInProgress.run({ rootCid, backend })
  }

  markDone(rootCid, backend, bytes) {
    this._markDone.run({ rootCid, backend, bytes })
  }

  markError(rootCid, backend, errorMsg) {
    this._markError.run({ rootCid, backend, errorMsg })
  }

  getPending(backend) {
    return this._getPending.all({ backend })
  }

  resetErrors() {
    this._resetErrors.run()
  }

  upsertSpace({ did, name, totalUploads, totalBytes }) {
    this._upsertSpace.run({ did, name, totalUploads, totalBytes })
  }

  getSpace(did) {
    return this._getSpace.get({ did })
  }

  getStats() {
    return this._getStats.get()
  }

  close() {
    this.db.close()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all 8 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/queue.js test/queue.test.js
git commit -m "feat: add SQLite job queue with resumability support"
```

---

## Chunk 2: Backend Interface + Local Backend

### Task 3: Backend interface and local-file backend

**Files:**
- Create: `src/backends/index.js`
- Create: `src/backends/local.js`
- Create: `test/backends/local.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/backends/local.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LocalBackend } from '../src/backends/local.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'

describe('LocalBackend', () => {
  let tmpDir
  let backend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-test-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('has name "local"', () => {
    assert.equal(backend.name, 'local')
  })

  it('hasContent returns false for missing CID', async () => {
    assert.equal(await backend.hasContent('bafynothere'), false)
  })

  it('importCar writes file and hasContent returns true', async () => {
    const data = Buffer.from('fake car data')
    const stream = Readable.from([data])
    await backend.importCar('bafytest123', stream)

    const filePath = path.join(tmpDir, 'bafytest123.car')
    assert.ok(fs.existsSync(filePath))
    assert.deepEqual(fs.readFileSync(filePath), data)
    assert.equal(await backend.hasContent('bafytest123'), true)
  })

  it('creates output directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'sub', 'dir')
    const be = new LocalBackend({ outputDir: nested })
    await be.init()
    assert.ok(fs.existsSync(nested))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

Expected: fails with module not found

- [ ] **Step 3: Create the backend interface**

Create `src/backends/index.js`:

```js
/**
 * @typedef {Object} ExportBackend
 * @property {string} name
 * @property {(rootCid: string) => Promise<boolean>} hasContent
 * @property {(rootCid: string, stream: import('node:stream').Readable) => Promise<void>} importCar
 * @property {() => Promise<void>} [init]
 * @property {() => Promise<void>} [close]
 */

import { LocalBackend } from './local.js'

const BACKENDS = {
  local: LocalBackend,
}

/**
 * @param {string} name
 * @param {object} config
 * @returns {ExportBackend}
 */
export function createBackend(name, config) {
  const Backend = BACKENDS[name]
  if (!Backend) {
    throw new Error(`Unknown backend: ${name}. Available: ${Object.keys(BACKENDS).join(', ')}`)
  }
  return new Backend(config)
}

export function listBackends() {
  return Object.keys(BACKENDS)
}
```

- [ ] **Step 4: Implement local backend**

Create `src/backends/local.js`:

```js
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

export class LocalBackend {
  constructor({ outputDir }) {
    this.name = 'local'
    this.outputDir = outputDir
  }

  async init() {
    fs.mkdirSync(this.outputDir, { recursive: true })
  }

  async hasContent(rootCid) {
    const filePath = path.join(this.outputDir, `${rootCid}.car`)
    return fs.existsSync(filePath)
  }

  async importCar(rootCid, stream) {
    fs.mkdirSync(this.outputDir, { recursive: true })
    const filePath = path.join(this.outputDir, `${rootCid}.car`)
    const dest = fs.createWriteStream(filePath)
    await pipeline(stream, dest)
  }

  async close() {}
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests pass (queue + local backend)

- [ ] **Step 6: Commit**

```bash
git add src/backends/ test/backends/
git commit -m "feat: add backend interface and local-file backend"
```

---

### Task 4: Kubo backend

**Files:**
- Create: `src/backends/kubo.js`
- Create: `test/backends/kubo.test.js`
- Modify: `src/backends/index.js`

- [ ] **Step 1: Write the failing test**

Create `test/backends/kubo.test.js`:

```js
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { KuboBackend } from '../src/backends/kubo.js'

describe('KuboBackend', () => {
  it('has name "kubo"', () => {
    const backend = new KuboBackend({ apiUrl: 'http://127.0.0.1:5001' })
    assert.equal(backend.name, 'kubo')
  })

  it('parses multiaddr to URL', () => {
    const backend = new KuboBackend({ apiUrl: '/ip4/127.0.0.1/tcp/5001' })
    assert.equal(backend.apiUrl, 'http://127.0.0.1:5001')
  })

  it('passes through http URLs', () => {
    const backend = new KuboBackend({ apiUrl: 'http://localhost:5001' })
    assert.equal(backend.apiUrl, 'http://localhost:5001')
  })

  // Integration tests (require a running kubo node) are skipped by default.
  // Run with: KUBO_API=http://127.0.0.1:5001 npm test
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

- [ ] **Step 3: Implement kubo backend**

Create `src/backends/kubo.js`:

```js
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
```

- [ ] **Step 4: Register kubo in backends/index.js**

Add to `src/backends/index.js`:

```js
import { KuboBackend } from './kubo.js'
```

Add to the BACKENDS object:

```js
const BACKENDS = {
  local: LocalBackend,
  kubo: KuboBackend,
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/backends/kubo.js test/backends/kubo.test.js src/backends/index.js
git commit -m "feat: add kubo backend with multiaddr parsing"
```

---

## Chunk 3: Auth + Enumerator

### Task 5: Auth — detect and reuse Storacha credentials

**Files:**
- Create: `src/auth.js`
- Create: `test/auth.test.js`

- [ ] **Step 1: Install storacha dependencies**

```bash
npm install @storacha/client @storacha/client
```

Note: `@storacha/client` bundles the stores/conf module we need.

- [ ] **Step 2: Write the failing test**

Create `test/auth.test.js`:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectCredentials } from '../src/auth.js'

describe('auth', () => {
  it('detectCredentials returns object with hasCredentials boolean', async () => {
    const result = await detectCredentials()
    assert.equal(typeof result.hasCredentials, 'boolean')
    // On a dev machine with storacha configured, this will be true.
    // On CI with no credentials, this will be false.
    // Either way the shape is correct.
  })

  it('detectCredentials returns spaces array', async () => {
    const result = await detectCredentials()
    assert.ok(Array.isArray(result.spaces))
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

```bash
npm test
```

- [ ] **Step 4: Implement auth module**

Create `src/auth.js`:

```js
import { create } from '@storacha/client'
import { StoreConf } from '@storacha/client/stores/conf'

/**
 * Try to load existing Storacha credentials.
 * Returns info about what's available.
 */
export async function detectCredentials(storeName = 'storacha-cli') {
  try {
    const store = new StoreConf({ profile: storeName })
    const client = await create({ store })

    const accounts = Object.entries(client.accounts())
    if (accounts.length === 0) {
      return { hasCredentials: false, spaces: [], accounts: [], client: null }
    }

    const spaces = client.spaces().map(s => ({
      did: s.did(),
      name: s.name || '(unnamed)',
    }))

    return {
      hasCredentials: true,
      accounts: accounts.map(([email]) => email),
      spaces,
      client,
    }
  } catch {
    return { hasCredentials: false, spaces: [], accounts: [], client: null }
  }
}

/**
 * Run interactive login flow.
 * @param {string} email
 */
export async function login(email) {
  const store = new StoreConf({ profile: 'storacha-export' })
  const client = await create({ store })
  const account = await client.login(email)
  await account.plan.wait()
  return client
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/auth.js test/auth.test.js
git commit -m "feat: add auth module with credential detection"
```

---

### Task 6: Enumerator — list spaces and uploads

**Files:**
- Create: `src/enumerator.js`
- Create: `test/enumerator.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/enumerator.test.js`:

```js
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enumerateUploads } from '../src/enumerator.js'

describe('enumerator', () => {
  it('enumerateUploads is an async generator', () => {
    // We can't test against real Storacha without credentials,
    // but we can verify the function exists and is the right type.
    assert.equal(typeof enumerateUploads, 'function')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

- [ ] **Step 3: Implement enumerator**

Create `src/enumerator.js`:

```js
/**
 * Enumerate all uploads across selected spaces.
 * Yields { rootCid, spaceDid, spaceName } for each upload.
 *
 * @param {import('@storacha/client').Client} client
 * @param {Array<{did: string, name: string}>} spaces
 * @param {object} [options]
 * @param {(msg: string) => void} [options.onProgress]
 */
export async function* enumerateUploads(client, spaces, options = {}) {
  const { onProgress } = options

  for (const space of spaces) {
    onProgress?.(`Enumerating ${space.name}...`)
    client.setCurrentSpace(space.did)

    let cursor
    let pageCount = 0

    do {
      const listOptions = { cursor }
      const result = await client.capability.upload.list(listOptions)

      for (const upload of result.results) {
        yield {
          rootCid: upload.root.toString(),
          spaceDid: space.did,
          spaceName: space.name,
        }
      }

      pageCount += result.results.length
      onProgress?.(`  ${space.name}: ${pageCount} uploads found...`)

      cursor = result.cursor
    } while (cursor)

    onProgress?.(`  ${space.name}: ${pageCount} uploads total`)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add src/enumerator.js test/enumerator.test.js
git commit -m "feat: add enumerator for listing uploads across spaces"
```

---

## Chunk 4: Executor + Progress

### Task 7: Executor — fetch CAR and stream to backends

**Files:**
- Create: `src/executor.js`
- Create: `test/executor.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/executor.test.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test
```

- [ ] **Step 3: Implement executor**

Create `src/executor.js`:

```js
import { Readable } from 'node:stream'
import { PassThrough } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const DEFAULT_GATEWAY = 'https://w3s.link'

export function buildGatewayUrl(rootCid, gatewayUrl = DEFAULT_GATEWAY) {
  return `${gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
}

/**
 * Execute a single export job: fetch CAR from gateway, stream to backends.
 *
 * @param {{ root_cid: string, backend: string }} job
 * @param {import('./backends/index.js').ExportBackend[]} backends
 * @param {import('./queue.js').JobQueue} queue
 * @param {object} [options]
 * @param {string} [options.gatewayUrl]
 * @param {(info: object) => void} [options.onProgress]
 * @param {number} [options.maxRetries]
 */
export async function executeJob(job, backends, queue, options = {}) {
  const { gatewayUrl, onProgress, maxRetries = 3 } = options
  const url = buildGatewayUrl(job.root_cid, gatewayUrl)

  queue.markInProgress(job.root_cid, job.backend)

  let lastError
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url)
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = res.headers.get('retry-after')
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid: job.root_cid, attempt, delay })
        await sleep(delay)
        continue
      }
      if (!res.ok) {
        throw new Error(`Gateway returned ${res.status}: ${res.statusText}`)
      }

      const nodeStream = Readable.fromWeb(res.body)

      if (backends.length === 1) {
        // Direct pipe — no tee overhead
        await backends[0].importCar(job.root_cid, nodeStream)
      } else {
        // Tee to multiple backends
        const streams = backends.map(() => new PassThrough())
        nodeStream.on('data', chunk => {
          for (const s of streams) s.write(chunk)
        })
        nodeStream.on('end', () => {
          for (const s of streams) s.end()
        })
        nodeStream.on('error', err => {
          for (const s of streams) s.destroy(err)
        })

        await Promise.all(
          backends.map((be, i) => be.importCar(job.root_cid, streams[i]))
        )
      }

      // Count bytes (approximate — from content-length if available)
      const bytes = parseInt(res.headers.get('content-length') || '0', 10)
      queue.markDone(job.root_cid, job.backend, bytes)
      onProgress?.({ type: 'done', rootCid: job.root_cid, bytes })
      return

    } catch (err) {
      lastError = err
      if (attempt < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 30000)
        onProgress?.({ type: 'retry', rootCid: job.root_cid, attempt, delay })
        await sleep(delay)
      }
    }
  }

  queue.markError(job.root_cid, job.backend, lastError?.message || 'unknown error')
  onProgress?.({ type: 'error', rootCid: job.root_cid, error: lastError?.message })
}

/**
 * Run all pending jobs with concurrency control.
 *
 * @param {import('./queue.js').JobQueue} queue
 * @param {import('./backends/index.js').ExportBackend[]} backends
 * @param {object} [options]
 * @param {number} [options.concurrency]
 * @param {string} [options.gatewayUrl]
 * @param {(info: object) => void} [options.onProgress]
 */
export async function executeAll(queue, backends, options = {}) {
  const { concurrency = 1, gatewayUrl, onProgress } = options
  const backendNames = backends.map(b => b.name)

  // Collect all pending jobs across backends
  const allPending = []
  for (const name of backendNames) {
    const pending = queue.getPending(name)
    allPending.push(...pending)
  }

  if (allPending.length === 0) {
    onProgress?.({ type: 'complete', total: 0 })
    return
  }

  // Simple concurrency pool
  let idx = 0
  const total = allPending.length

  async function worker() {
    while (idx < allPending.length) {
      const job = allPending[idx++]
      await executeJob(job, backends, queue, { gatewayUrl, onProgress })
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)

  onProgress?.({ type: 'complete', total })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/executor.js test/executor.test.js
git commit -m "feat: add executor with streaming, retry, and fan-out"
```

---

### Task 8: Progress display + logger

**Files:**
- Create: `src/progress.js`
- Create: `src/logger.js`

- [ ] **Step 1: Create logger**

Create `src/logger.js`:

```js
import pino from 'pino'

export function createLogger(options = {}) {
  const { logFormat, level } = options

  if (logFormat === 'json' || !process.stdout.isTTY) {
    return pino({
      level: level || process.env.LOG_LEVEL || 'info',
    })
  }

  // Pretty output for TTY — pino will handle this
  return pino({
    level: level || process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  })
}
```

Note: install `pino-pretty` as optional — logger degrades gracefully if not installed.

- [ ] **Step 2: Create progress display**

Create `src/progress.js`:

```js
import ora from 'ora'
import cliProgress from 'cli-progress'

const isTTY = process.stdout.isTTY

export function createSpinner(text) {
  if (isTTY) {
    return ora(text).start()
  }
  // Non-TTY: just log
  return {
    text,
    start() { console.log(text); return this },
    succeed(msg) { console.log(`✓ ${msg || this.text}`) },
    fail(msg) { console.log(`✗ ${msg || this.text}`) },
    stop() {},
    set text(t) { /* no-op for non-TTY */ },
    get text() { return text },
  }
}

export function createProgressBar(total) {
  if (isTTY) {
    const bar = new cliProgress.SingleBar({
      format: '{bar} {percentage}% | {value}/{total} | {cid} | {rate}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
    })
    bar.start(total, 0, { cid: 'starting...', rate: '' })
    return {
      update(value, payload) { bar.update(value, payload) },
      increment(payload) { bar.increment(1, payload) },
      stop() { bar.stop() },
    }
  }

  // Non-TTY: periodic log lines
  let current = 0
  return {
    update(value, payload) {
      current = value
      console.log(`[${current}/${total}] ${payload?.cid || ''}`)
    },
    increment(payload) {
      current++
      if (current % 10 === 0 || current === total) {
        console.log(`[${current}/${total}] ${payload?.cid || ''}`)
      }
    },
    stop() {
      console.log(`Completed: ${current}/${total}`)
    },
  }
}
```

- [ ] **Step 3: Verify imports work**

```bash
node -e "import('./src/progress.js').then(() => console.log('ok'))"
```

Expected: "ok"

- [ ] **Step 4: Commit**

```bash
git add src/progress.js src/logger.js
git commit -m "feat: add progress display (TTY bars + non-TTY logs)"
```

---

## Chunk 5: CLI + Wizard + Rooster

### Task 9: Farewell rooster

**Files:**
- Create: `src/rooster.js`

- [ ] **Step 1: Create the rooster**

Create `src/rooster.js`:

```js
// Storacha-themed farewell rooster
// Inspired by the Storacha logo at https://storacha.network/

const ROOSTER = `
    .--.
   /  oo\\
  |  \\__/|     🐔 Thanks for the memories, Storacha!
   \\    / \\
    )  (   \\   Your data is safe now.
   /    \\   \\  All uploads exported successfully.
  /  /\\  \\   |
 (  /  \\  )  |
  \\/    \\/  /
   |      |  /
   |      |/
   |______|
   |  ||  |
   |  ||  |
   (__)(__)
`

const ROOSTER_WITH_STATS = (stats) => `
    .--.
   /  oo\\
  |  \\__/|     🐔 Cock-a-doodle-done!
   \\    / \\
    )  (   \\   Exported ${stats.total} uploads across ${stats.spaces} spaces.
   /    \\   \\  ${stats.bytes} transferred to ${stats.backends}.
  /  /\\  \\   |
 (  /  \\  )  | Farewell, Storacha. Your data lives on! 🌅
  \\/    \\/  /
   |      |  /
   |      |/
   |______|
   |  ||  |
   |  ||  |
   (__)(__)
`

export function printRooster(stats) {
  if (stats) {
    console.log(ROOSTER_WITH_STATS(stats))
  } else {
    console.log(ROOSTER)
  }
}
```

- [ ] **Step 2: Verify it looks good**

```bash
node -e "import('./src/rooster.js').then(m => m.printRooster({ total: 42, spaces: 3, bytes: '1.2 TiB', backends: 'kubo, local' }))"
```

- [ ] **Step 3: Commit**

```bash
git add src/rooster.js
git commit -m "feat: add farewell rooster for export completion"
```

---

### Task 10: CLI with wizard and command-line options

**Files:**
- Modify: `src/cli.js` (full rewrite)

- [ ] **Step 1: Implement the CLI**

Rewrite `src/cli.js`:

```js
import { Command } from 'commander'
import { checkbox, confirm, input, select } from '@inquirer/prompts'
import { detectCredentials, login } from './auth.js'
import { enumerateUploads } from './enumerator.js'
import { JobQueue } from './queue.js'
import { createBackend, listBackends } from './backends/index.js'
import { executeAll } from './executor.js'
import { createSpinner, createProgressBar } from './progress.js'
import { printRooster } from './rooster.js'
import fs from 'node:fs'
import path from 'node:path'

function filesize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
  return `${(bytes / 1024 / 1024 / 1024 / 1024).toFixed(1)} TiB`
}

export async function main(argv) {
  const program = new Command()

  program
    .name('storacha-export')
    .description('Export Storacha space content to storage backends')
    .version('0.1.0')
    .option('--backend <type...>', 'Backend(s) to export to (local, kubo, cluster)')
    .option('--output <dir>', 'Output directory for local backend')
    .option('--kubo-api <url>', 'Kubo API endpoint (URL or multiaddr)')
    .option('--cluster-api <url>', 'IPFS Cluster API endpoint')
    .option('--space <name...>', 'Export only these spaces (repeatable)')
    .option('--exclude-space <name...>', 'Exclude these spaces (repeatable)')
    .option('--continue', 'Resume a previous export')
    .option('--concurrency <n>', 'Concurrent transfers', parseInt, 1)
    .option('--dry-run', 'Enumerate only, do not transfer')
    .option('--gateway <url>', 'Gateway URL', 'https://w3s.link')
    .option('--db <path>', 'SQLite database path', 'storacha-export.db')
    .option('--log-format <format>', 'Log format: text or json')

  program.parse(argv)
  const opts = program.opts()

  // Determine if we need the wizard
  const needsWizard = !opts.backend || opts.backend.length === 0

  // --- Auth ---
  const spinner = createSpinner('Checking for Storacha credentials...')
  const creds = await detectCredentials()

  let client
  if (creds.hasCredentials) {
    spinner.succeed(
      `Found credentials for ${creds.accounts.join(', ')} with access to ${creds.spaces.length} spaces`
    )
    if (needsWizard) {
      const useThem = await confirm({
        message: 'Use these credentials?',
        default: true,
      })
      if (!useThem) {
        const email = await input({ message: 'Email to log in with:' })
        client = await login(email)
      } else {
        client = creds.client
      }
    } else {
      client = creds.client
    }
  } else {
    spinner.fail('No Storacha credentials found')
    const email = await input({ message: 'Email to log in with:' })
    client = await login(email)
  }

  // --- Space selection ---
  let allSpaces = client.spaces().map(s => ({ did: s.did(), name: s.name || '(unnamed)' }))
  let selectedSpaces

  if (opts.space) {
    // CLI space filter
    selectedSpaces = allSpaces.filter(s =>
      opts.space.some(name => s.name.toLowerCase() === name.toLowerCase())
    )
    if (selectedSpaces.length === 0) {
      console.error(`No spaces matched: ${opts.space.join(', ')}`)
      console.error(`Available: ${allSpaces.map(s => s.name).join(', ')}`)
      process.exit(1)
    }
  } else if (opts.excludeSpace) {
    selectedSpaces = allSpaces.filter(s =>
      !opts.excludeSpace.some(name => s.name.toLowerCase() === name.toLowerCase())
    )
  } else if (needsWizard) {
    // Interactive space selection
    const choices = allSpaces.map(s => ({
      name: s.name,
      value: s,
      checked: true,
    }))
    selectedSpaces = await checkbox({
      message: 'Select spaces to export:',
      choices,
    })
    if (selectedSpaces.length === 0) {
      console.log('No spaces selected. Exiting.')
      process.exit(0)
    }
  } else {
    selectedSpaces = allSpaces
  }

  console.log(`\nExporting ${selectedSpaces.length} space(s): ${selectedSpaces.map(s => s.name).join(', ')}`)

  // --- Backend selection ---
  let backends = []

  if (needsWizard) {
    const backendChoices = [
      { name: 'Local CAR files', value: 'local' },
      { name: 'Kubo (IPFS node)', value: 'kubo' },
      { name: 'IPFS Cluster', value: 'cluster' },
    ]
    const selectedBackends = await checkbox({
      message: 'Select export backends:',
      choices: backendChoices,
    })

    for (const name of selectedBackends) {
      if (name === 'local') {
        const dir = await input({
          message: 'Output directory for CAR files:',
          default: './storacha-cars',
        })
        backends.push(createBackend('local', { outputDir: dir }))
      } else if (name === 'kubo') {
        const api = await input({
          message: 'Kubo API endpoint:',
          default: '/ip4/127.0.0.1/tcp/5001',
        })
        backends.push(createBackend('kubo', { apiUrl: api }))
      } else if (name === 'cluster') {
        const api = await input({
          message: 'IPFS Cluster API endpoint:',
          default: 'http://127.0.0.1:9094',
        })
        backends.push(createBackend('cluster', { apiUrl: api }))
      }
    }
  } else {
    for (const name of opts.backend) {
      if (name === 'local') {
        if (!opts.output) {
          console.error('--output required for local backend')
          process.exit(1)
        }
        backends.push(createBackend('local', { outputDir: opts.output }))
      } else if (name === 'kubo') {
        if (!opts.kuboApi) {
          console.error('--kubo-api required for kubo backend')
          process.exit(1)
        }
        backends.push(createBackend('kubo', { apiUrl: opts.kuboApi }))
      } else if (name === 'cluster') {
        if (!opts.clusterApi) {
          console.error('--cluster-api required for cluster backend')
          process.exit(1)
        }
        backends.push(createBackend('cluster', { apiUrl: opts.clusterApi }))
      }
    }
  }

  if (backends.length === 0) {
    console.error('No backends selected. Exiting.')
    process.exit(1)
  }

  // --- Init backends ---
  for (const be of backends) {
    if (be.init) await be.init()
  }

  // --- Open/create job queue ---
  const dbPath = opts.db
  let queue

  if (opts.continue && !fs.existsSync(dbPath)) {
    console.log('No previous database found. Will check backends for existing content.')
  }
  queue = new JobQueue(dbPath)

  // --- Enumerate ---
  const enumSpinner = createSpinner('Enumerating uploads...')
  let enumCount = 0

  for await (const upload of enumerateUploads(client, selectedSpaces, {
    onProgress: (msg) => { enumSpinner.text = msg },
  })) {
    // For --continue without DB, check backends before queuing
    if (opts.continue) {
      let alreadyDone = true
      for (const be of backends) {
        if (!(await be.hasContent(upload.rootCid))) {
          alreadyDone = false
          break
        }
      }
      if (alreadyDone) continue
    }

    for (const be of backends) {
      queue.addJob({
        rootCid: upload.rootCid,
        spaceDid: upload.spaceDid,
        spaceName: upload.spaceName,
        backend: be.name,
      })
    }
    enumCount++
  }

  enumSpinner.succeed(`Enumerated ${enumCount} uploads to export`)

  if (opts.dryRun) {
    const stats = queue.getStats()
    console.log(`\nDry run complete:`)
    console.log(`  Total jobs: ${stats.total}`)
    console.log(`  Spaces: ${selectedSpaces.map(s => s.name).join(', ')}`)
    console.log(`  Backends: ${backends.map(b => b.name).join(', ')}`)
    queue.close()
    process.exit(0)
  }

  // --- Execute ---
  const stats = queue.getStats()
  const bar = createProgressBar(stats.pending)
  let completed = 0

  await executeAll(queue, backends, {
    concurrency: opts.concurrency,
    gatewayUrl: opts.gateway,
    onProgress: (info) => {
      if (info.type === 'done') {
        completed++
        bar.increment({
          cid: info.rootCid.slice(0, 20) + '...',
          rate: info.bytes ? filesize(info.bytes) : '',
        })
      } else if (info.type === 'error') {
        // Errors logged but we continue
      } else if (info.type === 'complete') {
        bar.stop()
      }
    },
  })

  bar.stop()

  // --- Summary ---
  const finalStats = queue.getStats()
  console.log(`\nExport complete:`)
  console.log(`  Done:    ${finalStats.done}`)
  console.log(`  Errors:  ${finalStats.error}`)
  console.log(`  Pending: ${finalStats.pending}`)

  if (finalStats.error === 0 && finalStats.pending === 0) {
    printRooster({
      total: finalStats.done,
      spaces: selectedSpaces.length,
      bytes: filesize(
        queue.db.prepare('SELECT SUM(bytes_transferred) as total FROM jobs WHERE status = ?')
          .get('done')?.total || 0
      ),
      backends: backends.map(b => b.name).join(', '),
    })
  } else if (finalStats.error > 0) {
    console.log(`\nRe-run with --continue to retry failed exports.`)
  }

  // --- Cleanup ---
  for (const be of backends) {
    if (be.close) await be.close()
  }
  queue.close()
}
```

- [ ] **Step 2: Verify it runs in help mode**

```bash
node bin/storacha-export.js --help
```

Expected: shows usage with all options

- [ ] **Step 3: Verify dry-run works (requires Storacha credentials)**

```bash
node bin/storacha-export.js --dry-run --backend local --output /tmp/test-cars --space Demos
```

Expected: enumerates the Demos space (1 upload), shows dry run summary

- [ ] **Step 4: Commit**

```bash
git add src/cli.js
git commit -m "feat: add CLI with interactive wizard and command-line options"
```

---

### Task 11: IPFS Cluster backend stub

**Files:**
- Create: `src/backends/cluster.js`
- Modify: `src/backends/index.js`

- [ ] **Step 1: Create cluster backend**

Create `src/backends/cluster.js`:

```js
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
```

- [ ] **Step 2: Register in backends/index.js**

Add import and entry:

```js
import { ClusterBackend } from './cluster.js'

const BACKENDS = {
  local: LocalBackend,
  kubo: KuboBackend,
  cluster: ClusterBackend,
}
```

- [ ] **Step 3: Commit**

```bash
git add src/backends/cluster.js src/backends/index.js
git commit -m "feat: add IPFS Cluster backend"
```

---

## Chunk 6: Integration Test + Polish

### Task 12: End-to-end test with local backend

**Files:**
- Create: `test/e2e.test.js`

- [ ] **Step 1: Write the e2e test**

Create `test/e2e.test.js`:

```js
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('e2e: storacha-export', () => {
  it('shows help', () => {
    const out = execFileSync('node', ['bin/storacha-export.js', '--help'], {
      encoding: 'utf8',
    })
    assert.ok(out.includes('storacha-export'))
    assert.ok(out.includes('--backend'))
    assert.ok(out.includes('--space'))
    assert.ok(out.includes('--exclude-space'))
    assert.ok(out.includes('--continue'))
  })

  it('shows version', () => {
    const out = execFileSync('node', ['bin/storacha-export.js', '--version'], {
      encoding: 'utf8',
    })
    assert.ok(out.includes('0.1.0'))
  })
})
```

- [ ] **Step 2: Run e2e tests**

```bash
npm test
```

Expected: all tests pass

- [ ] **Step 3: Commit**

```bash
git add test/e2e.test.js
git commit -m "test: add e2e tests for CLI help and version"
```

---

### Task 13: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Create `README.md`:

```markdown
# storacha-export

Export your Storacha space content to local files, IPFS (Kubo), or IPFS Cluster.


## Install

```bash
npm install -g storacha-export
```

Or run directly:

```bash
npx storacha-export
```

## Quick Start

Run without arguments for the interactive wizard:

```bash
storacha-export
```

The wizard will:
1. Detect your existing Storacha credentials (or help you log in)
2. Let you select which spaces to export
3. Let you choose where to export (local files, Kubo, IPFS Cluster)
4. Start the export with progress tracking

## CLI Usage

```bash
# Export to local CAR files
storacha-export --backend local --output ./my-cars/

# Export to a Kubo node
storacha-export --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export to multiple backends at once
storacha-export --backend local --output ./cars/ --backend kubo --kubo-api /ip4/127.0.0.1/tcp/5001

# Export specific spaces only
storacha-export --space "MySpace" --space "OtherSpace" --backend local --output ./cars/

# Export all except certain spaces
storacha-export --exclude-space "BigSpace" --backend local --output ./cars/

# Resume an interrupted export
storacha-export --continue --backend local --output ./cars/

# Dry run — see what would be exported
storacha-export --dry-run --backend local --output ./cars/
```

## Options

| Option | Description |
|--------|-------------|
| `--backend <type...>` | Backend(s): `local`, `kubo`, `cluster` |
| `--output <dir>` | Output directory (local backend) |
| `--kubo-api <url>` | Kubo API endpoint (URL or multiaddr) |
| `--cluster-api <url>` | IPFS Cluster API endpoint |
| `--space <name...>` | Export only named spaces (repeatable) |
| `--exclude-space <name...>` | Skip named spaces (repeatable) |
| `--continue` | Resume previous export |
| `--concurrency <n>` | Parallel transfers (default: 1) |
| `--dry-run` | Enumerate only |
| `--gateway <url>` | Gateway URL (default: https://w3s.link) |
| `--db <path>` | SQLite DB path (default: storacha-export.db) |

## Resumability

Export progress is tracked in a SQLite database (`storacha-export.db`). If an export is interrupted, re-run with `--continue` to pick up where you left off.

Even if the database is lost, `--continue` will check each backend to see what content is already present before re-downloading.

## License

AGPL-3.0-or-later
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with usage instructions"
```

---

### Task 14: Manual integration test against real Storacha + fatfil

This task requires Danny's Storacha credentials and SSH access to fatfil.

- [ ] **Step 1: Test dry-run against real account**

```bash
cd ~/Private/filecoin/storacha-transition/storacha-export
node bin/storacha-export.js --dry-run --backend local --output /tmp/test-cars
```

Verify: credential detection works, spaces are listed, enumeration completes.

- [ ] **Step 2: Test local export of smallest space (Demos)**

```bash
node bin/storacha-export.js --space Demos --backend local --output /tmp/test-cars
```

Verify: one CAR file appears in `/tmp/test-cars/`

- [ ] **Step 3: Test kubo export to fatfil**

```bash
node bin/storacha-export.js --space Demos --backend kubo --kubo-api http://fatfil:5001
```

Verify: CID appears pinned on fatfil (`ssh fatfil ipfs pin ls | grep <cid>`)

- [ ] **Step 4: Test resumability**

Start an export with multiple spaces, kill it mid-way (Ctrl+C), re-run with `--continue`:

```bash
node bin/storacha-export.js --space Smithsonian --backend local --output /tmp/test-cars
# Ctrl+C after a few
node bin/storacha-export.js --continue --space Smithsonian --backend local --output /tmp/test-cars
```

Verify: resumes from where it stopped, doesn't re-download completed CIDs.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: adjustments from integration testing"
```

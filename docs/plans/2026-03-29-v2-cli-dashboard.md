# storacha-export v2: CLI + Phases + Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the user-facing layer — CLI with wizard, three-phase orchestration (discover, export, verify), and integrated live dashboard.

**Architecture:** Thin CLI parses args or runs wizard, then calls phase functions in sequence. Dashboard is an HTTP server serving HTML generated from in-process state. All progress flows through a central event emitter.

**Tech Stack:** commander, @inquirer/prompts, ora, cli-progress, node:http

**Spec:** `docs/design-v2.md`

**Depends on:** Plan 1 (core + kubo backend) must be complete.

**Branch:** `v2` (continues from Plan 1)

---

## Chunk 1: Auth + Discovery Phase

### Task 1: Port auth module to TypeScript

**Files:**
- Create: `src/phases/discover.ts`
- Create: `src/auth.ts`
- Create: `test/phases/discover.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/phases/discover.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { detectCredentials } from '../src/auth'

describe('detectCredentials', () => {
  it('returns object with hasCredentials boolean', async () => {
    const result = await detectCredentials()
    expect(typeof result.hasCredentials).toBe('boolean')
  })

  it('returns spaces array', async () => {
    const result = await detectCredentials()
    expect(Array.isArray(result.spaces)).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/phases/discover.test.ts
```

- [ ] **Step 3: Implement auth.ts (port from v1)**

Create `src/auth.ts`:

```typescript
import { create } from '@storacha/client'
import { StoreConf } from '@storacha/client/stores/conf'

export interface SpaceInfo {
  did: string
  name: string
}

export interface CredentialResult {
  hasCredentials: boolean
  profile: string | null
  accounts: string[]
  spaces: SpaceInfo[]
  client: any | null
}

export async function detectCredentials(): Promise<CredentialResult> {
  const profiles = ['storacha-export', 'storacha-cli']

  for (const profile of profiles) {
    try {
      const store = new StoreConf({ profile })
      const client = await create({ store })
      const accounts = Object.entries(client.accounts())
      if (accounts.length === 0) continue

      const spaces = client.spaces().map((s: any) => ({
        did: s.did(),
        name: s.name || '(unnamed)',
      }))

      return {
        hasCredentials: true,
        profile,
        accounts: accounts.map(([email]: [string, any]) => email),
        spaces,
        client,
      }
    } catch {
      continue
    }
  }

  return { hasCredentials: false, profile: null, spaces: [], accounts: [], client: null }
}

export async function login(email: string) {
  const store = new StoreConf({ profile: 'storacha-export' })
  const client = await create({ store })
  const account = await client.login(email)
  await account.plan.wait()
  return client
}
```

- [ ] **Step 4: Implement discover phase**

Create `src/phases/discover.ts`:

```typescript
import { detectCredentials, login } from '../auth'
import type { UploadQueue } from '../core/queue'
import type Database from 'better-sqlite3'
import { log } from '../util/log'

export interface DiscoverResult {
  client: any
  spaces: Array<{ did: string; name: string; totalBytes?: number }>
}

/**
 * Enumerate all uploads across selected spaces.
 * Yields { rootCid, spaceDid, spaceName } for each upload.
 */
export async function* enumerateUploads(
  client: any,
  spaces: Array<{ did: string; name: string }>,
): AsyncIterable<{ rootCid: string; spaceDid: string; spaceName: string }> {
  for (const space of spaces) {
    log('INFO', `Enumerating ${space.name}...`)
    client.setCurrentSpace(space.did)
    let cursor: string | undefined
    let count = 0

    do {
      const result = await client.capability.upload.list({ cursor })
      for (const upload of result.results) {
        yield {
          rootCid: upload.root.toString(),
          spaceDid: space.did,
          spaceName: space.name,
        }
      }
      count += result.results.length
      log('INFO', `  ${space.name}: ${count} uploads found...`)
      cursor = result.cursor
    } while (cursor)

    log('INFO', `  ${space.name}: ${count} total`)
  }
}

/**
 * Collect space sizes via usage report API.
 * Caches in DB — skips API calls on subsequent runs.
 */
export async function collectSpaceSizes(
  client: any,
  spaces: Array<{ did: string; name: string }>,
  db: Database.Database,
): Promise<Map<string, number>> {
  const sizes = new Map<string, number>()

  // Check cache first
  const cached = db.prepare('SELECT did, total_bytes FROM spaces WHERE total_bytes > 0').all() as Array<{ did: string; total_bytes: number }>
  const cachedMap = new Map(cached.map(r => [r.did, r.total_bytes]))
  const allCached = spaces.every(s => cachedMap.has(s.did))

  if (allCached) {
    log('INFO', 'Using cached space sizes')
    for (const s of spaces) sizes.set(s.did, cachedMap.get(s.did)!)
    return sizes
  }

  log('INFO', 'Querying usage reports (this can be slow)...')
  const now = new Date()
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const period = { from, to: now }

  try {
    for (const account of Object.values(client.accounts())) {
      const subs = await (account as any).capability?.subscription?.list?.((account as any).did()) ??
        await client.capability.subscription.list((account as any).did())
      for (const { consumers } of subs.results) {
        for (const spaceDid of consumers) {
          const space = spaces.find(s => s.did === spaceDid)
          if (!space) continue
          try {
            const result = await client.capability.usage.report(spaceDid, period)
            let total = 0
            for (const [, report] of Object.entries(result)) {
              total += (report as any)?.size?.final || 0
            }
            sizes.set(spaceDid, total)
            log('INFO', `  ${space.name}: ${(total / 1024 / 1024).toFixed(1)} MiB`)

            db.prepare(
              `INSERT INTO spaces (did, name, total_bytes, enumerated_at) VALUES (?, ?, ?, datetime('now'))
               ON CONFLICT(did) DO UPDATE SET total_bytes = ?, enumerated_at = datetime('now')`
            ).run(spaceDid, space.name, total, total)
          } catch {
            log('INFO', `  ${space.name}: skipped (no access)`)
          }
        }
      }
    }
  } catch {
    log('INFO', 'Could not collect sizes')
  }

  return sizes
}
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run test/phases/discover.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/auth.ts src/phases/discover.ts test/phases/discover.test.ts
git commit -m "feat: auth detection and discovery phase with space enumeration"
```

---

### Task 2: Export phase orchestration

**Files:**
- Create: `src/phases/export.ts`
- Create: `test/phases/export.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/phases/export.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runExport } from '../src/phases/export'
import { UploadQueue } from '../src/core/queue'
import { BlockManifest } from '../src/core/manifest'
import { createDatabase } from '../src/core/db'
import { makeRawBlock, makeDagPBNode, buildCarBytes } from './core/blocks.test'
import http from 'node:http'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { ExportBackend } from '../src/backends/interface'
import type { BlockStream } from '../src/core/blocks'

const TEST_DB = '/tmp/storacha-v2-export-phase-test.db'

class MemoryBackend implements ExportBackend {
  name = 'memory'
  blocks = new Map<string, Uint8Array>()
  pinned = new Set<string>()
  async importCar(rootCid: string, blocks: BlockStream) {
    for await (const block of blocks) this.blocks.set(block.cid.toString(), block.bytes)
    this.pinned.add(rootCid)
  }
  async hasContent(rootCid: string) { return this.pinned.has(rootCid) }
  async hasBlock(cid: string) { return this.blocks.has(cid) }
  async putBlock(cid: string, bytes: Uint8Array) { this.blocks.set(cid, bytes) }
}

describe('runExport', () => {
  let db: Database.Database
  let queue: UploadQueue
  let manifest: BlockManifest

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    queue = new UploadQueue(db)
    manifest = new BlockManifest(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('exports multiple uploads with concurrency', async () => {
    const leaf1 = await makeRawBlock('file-a')
    const root1 = await makeDagPBNode([leaf1])
    const car1 = await buildCarBytes([root1, leaf1], [root1])

    const leaf2 = await makeRawBlock('file-b')
    const root2 = await makeDagPBNode([leaf2])
    const car2 = await buildCarBytes([root2, leaf2], [root2])

    const carMap = new Map<string, Uint8Array>([
      [root1.cid.toString(), car1],
      [root2.cid.toString(), car2],
    ])

    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://${req.headers.host}`)
      const cidMatch = url.pathname.match(/\/ipfs\/([^?]+)/)
      if (cidMatch && carMap.has(cidMatch[1])) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
        res.end(carMap.get(cidMatch[1]))
      } else {
        res.writeHead(404); res.end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const gatewayUrl = `http://127.0.0.1:${(server.address() as any).port}`

    const backend = new MemoryBackend()
    queue.add({ rootCid: root1.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })
    queue.add({ rootCid: root2.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })

    await runExport({
      queue,
      manifest,
      backends: [backend],
      gatewayUrl,
      concurrency: 2,
      spaceNames: ['TestSpace'],
    })

    expect(queue.getStatus(root1.cid.toString(), 'memory')).toBe('complete')
    expect(queue.getStatus(root2.cid.toString(), 'memory')).toBe('complete')

    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/phases/export.test.ts
```

- [ ] **Step 3: Implement export phase**

Create `src/phases/export.ts`:

```typescript
import { exportUpload } from '../core/pipeline'
import type { UploadQueue } from '../core/queue'
import type { BlockManifest } from '../core/manifest'
import type { ExportBackend } from '../backends/interface'
import { log } from '../util/log'

export interface ExportOptions {
  queue: UploadQueue
  manifest: BlockManifest
  backends: ExportBackend[]
  gatewayUrl: string
  concurrency?: number
  spaceNames?: string[]
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

export async function runExport(options: ExportOptions): Promise<void> {
  const { queue, manifest, backends, gatewayUrl, concurrency = 1, spaceNames, onProgress } = options

  for (const backend of backends) {
    let pending = spaceNames
      ? queue.getPendingForSpaces(backend.name, spaceNames)
      : queue.getPending(backend.name)

    log('INFO', `${pending.length} pending jobs for ${backend.name}`)

    if (pending.length === 0) continue

    let idx = 0

    async function worker() {
      while (idx < pending.length) {
        const upload = pending[idx++]
        await exportUpload({
          rootCid: upload.root_cid,
          backend,
          queue,
          manifest,
          gatewayUrl,
          onProgress,
        })
      }
    }

    const workers = Array.from({ length: concurrency }, () => worker())
    await Promise.all(workers)
  }

  onProgress?.({ type: 'export-complete' })
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/phases/export.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/phases/export.ts test/phases/export.test.ts
git commit -m "feat: export phase with concurrency and space filtering"
```

---

### Task 3: Verify phase

**Files:**
- Create: `src/phases/verify.ts`
- Create: `test/phases/verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/phases/verify.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { runVerify } from '../src/phases/verify'
import { UploadQueue } from '../src/core/queue'
import { createDatabase } from '../src/core/db'
import fs from 'node:fs'
import type Database from 'better-sqlite3'
import type { ExportBackend } from '../src/backends/interface'
import type { BlockStream } from '../src/core/blocks'

const TEST_DB = '/tmp/storacha-v2-verify-test.db'

describe('runVerify', () => {
  let db: Database.Database
  let queue: UploadQueue

  beforeEach(() => {
    db = createDatabase(TEST_DB)
    queue = new UploadQueue(db)
  })

  afterEach(() => {
    db.close()
    try { fs.unlinkSync(TEST_DB) } catch {}
    try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
    try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
  })

  it('verifies complete uploads', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
      async verifyDag() { return { valid: true } },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(result.verified).toBe(1)
    expect(result.failed).toBe(0)
  })

  it('moves failed verification back to partial', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
      async verifyDag() { return { valid: false, error: 'missing blocks' } },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(result.verified).toBe(0)
    expect(result.failed).toBe(1)
    expect(queue.getStatus('bafyA', 'mock')).toBe('partial')
  })

  it('falls back to hasContent when verifyDag not available', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(result.verified).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/phases/verify.test.ts
```

- [ ] **Step 3: Implement verify phase**

Create `src/phases/verify.ts`:

```typescript
import type { UploadQueue } from '../core/queue'
import type { ExportBackend } from '../backends/interface'
import { log } from '../util/log'

export interface VerifyOptions {
  queue: UploadQueue
  backends: ExportBackend[]
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

export interface VerifyResult {
  verified: number
  failed: number
  errors: Array<{ rootCid: string; backend: string; error: string }>
}

export async function runVerify(options: VerifyOptions): Promise<VerifyResult> {
  const { queue, backends, onProgress } = options
  let verified = 0
  let failed = 0
  const errors: VerifyResult['errors'] = []

  for (const backend of backends) {
    const complete = queue.db.prepare(
      "SELECT * FROM uploads WHERE backend = ? AND status = 'complete'"
    ).all(backend.name) as Array<{ root_cid: string; space_name: string }>

    log('VERIFY', `Checking ${complete.length} complete uploads in ${backend.name}`)

    for (const upload of complete) {
      const tag = `[${upload.space_name}] ${upload.root_cid.slice(0, 24)}...`
      onProgress?.({ type: 'verifying', rootCid: upload.root_cid, spaceName: upload.space_name })

      try {
        let valid: boolean
        let error: string | undefined

        if (backend.verifyDag) {
          const result = await backend.verifyDag(upload.root_cid)
          valid = result.valid
          error = result.error
        } else {
          valid = await backend.hasContent(upload.root_cid)
          if (!valid) error = 'Content not found'
        }

        if (valid) {
          verified++
          onProgress?.({ type: 'verified', rootCid: upload.root_cid })
        } else {
          failed++
          log('VERIFY', `${tag} FAILED: ${error}`)
          queue.setStatus(upload.root_cid, backend.name, 'partial')
          errors.push({ rootCid: upload.root_cid, backend: backend.name, error: error || 'unknown' })
          onProgress?.({ type: 'verify-failed', rootCid: upload.root_cid, error })
        }
      } catch (err: any) {
        failed++
        log('VERIFY', `${tag} ERROR: ${err.message}`)
        queue.setStatus(upload.root_cid, backend.name, 'partial')
        errors.push({ rootCid: upload.root_cid, backend: backend.name, error: err.message })
      }
    }
  }

  log('VERIFY', `Complete: ${verified} verified, ${failed} failed`)
  return { verified, failed, errors }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/phases/verify.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/phases/verify.ts test/phases/verify.test.ts
git commit -m "feat: verify phase — confirms exports, moves failures back to partial"
```

---

## Chunk 2: CLI + Wizard

### Task 4: CLI argument parsing and wizard

**Files:**
- Create: `src/cli.ts`
- Create: `src/index.ts`
- Create: `bin/storacha-export.js`
- Modify: `package.json`
- Create: `test/e2e.test.ts`

- [ ] **Step 1: Write the failing e2e test**

Create `test/e2e.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'

describe('e2e: storacha-export', () => {
  it('shows help', () => {
    const out = execFileSync('npx', ['tsx', 'src/index.ts', '--help'], { encoding: 'utf8' })
    expect(out).toContain('storacha-export')
    expect(out).toContain('--backend')
    expect(out).toContain('--space')
    expect(out).toContain('--exclude-space')
    expect(out).toContain('--fresh')
    expect(out).toContain('--verify')
    expect(out).toContain('--serve')
    expect(out).toContain('--concurrency')
  })

  it('shows version', () => {
    const out = execFileSync('npx', ['tsx', 'src/index.ts', '--version'], { encoding: 'utf8' })
    expect(out).toContain('2.0.0')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm install --save-dev tsx
npx vitest run test/e2e.test.ts
```

- [ ] **Step 3: Implement CLI**

Create `src/index.ts`:

```typescript
import { main } from './cli'
main(process.argv)
```

Create `src/cli.ts`:

```typescript
import { Command } from 'commander'
import { checkbox, confirm, input } from '@inquirer/prompts'
import { detectCredentials, login } from './auth'
import { enumerateUploads, collectSpaceSizes } from './phases/discover'
import { runExport } from './phases/export'
import { runVerify } from './phases/verify'
import { createDatabase } from './core/db'
import { UploadQueue } from './core/queue'
import { BlockManifest } from './core/manifest'
import { createBackend } from './backends/registry'
import { startDashboard } from './dashboard/server'
import { log } from './util/log'
import fs from 'node:fs'

function filesize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`
  if (bytes < 1024 ** 4) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
  return `${(bytes / 1024 ** 4).toFixed(1)} TiB`
}

export async function main(argv: string[]) {
  try {
    await _main(argv)
  } catch (err: any) {
    if (err.name === 'ExitPromptError' || err.message?.includes('force closed')) {
      process.stdout.write('\x1B[?25h')
      console.log('\nExiting.')
      process.exit(0)
    }
    throw err
  }
}

async function _main(argv: string[]) {
  const program = new Command()

  program
    .name('storacha-export')
    .description('Export Storacha space content to storage backends')
    .version('2.0.0')
    .option('--backend <type...>', 'Backend(s): local, kubo, cluster')
    .option('--output <dir>', 'Output directory (local backend)')
    .option('--kubo-api <url>', 'Kubo API endpoint (URL or multiaddr)')
    .option('--cluster-api <url>', 'IPFS Cluster API endpoint')
    .option('--space <name...>', 'Export only named spaces (repeatable)')
    .option('--exclude-space <name...>', 'Skip named spaces (repeatable)')
    .option('--fresh', 'Start over, discarding previous progress tracking')
    .option('--verify', 'Run verification only (skip export)')
    .option('--concurrency <n>', 'Parallel transfers', (v: string) => parseInt(v, 10), 1)
    .option('--dry-run', 'Enumerate only')
    .option('--gateway <url>', 'Gateway URL', 'https://w3s.link')
    .option('--db <path>', 'SQLite database path', 'storacha-export.db')
    .option('--serve [host:port]', 'Start dashboard HTTP server')
    .option('--serve-password <pass>', 'Dashboard HTTP Basic Auth password')
    .option('--html-out <path>', 'Write dashboard HTML to file periodically')

  program.parse(argv)
  const opts = program.opts()
  const needsWizard = !opts.backend || opts.backend.length === 0

  // --- Auth ---
  log('INFO', 'Checking for Storacha credentials...')
  const creds = await detectCredentials()

  let client: any
  if (creds.hasCredentials) {
    log('INFO', `Found credentials for ${creds.accounts.join(', ')} with ${creds.spaces.length} spaces`)
    if (needsWizard) {
      const useThem = await confirm({ message: 'Use these credentials?', default: true })
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
    log('INFO', 'No credentials found')
    const email = await input({ message: 'Email to log in with:' })
    client = await login(email)
  }

  // --- Space selection ---
  const allSpaces = client.spaces().map((s: any) => ({ did: s.did(), name: s.name || '(unnamed)' }))
  let selectedSpaces: typeof allSpaces

  if (opts.space) {
    selectedSpaces = allSpaces.filter((s: any) => opts.space.some((n: string) => s.name.toLowerCase() === n.toLowerCase()))
  } else if (opts.excludeSpace) {
    selectedSpaces = allSpaces.filter((s: any) => !opts.excludeSpace.some((n: string) => s.name.toLowerCase() === n.toLowerCase()))
  } else if (needsWizard) {
    selectedSpaces = await checkbox({
      message: 'Select spaces to export (Space to toggle, Enter to confirm):',
      choices: allSpaces.map((s: any) => ({ name: s.name, value: s, checked: true })),
      required: true,
    })
  } else {
    selectedSpaces = allSpaces
  }

  console.log(`\nExporting ${selectedSpaces.length} space(s): ${selectedSpaces.map((s: any) => s.name).join(', ')}`)

  // --- Backend selection ---
  // (Similar wizard/CLI logic as v1, using createBackend registry)
  // ... [abbreviated — same pattern as v1 but calling createBackend()]

  // --- DB setup ---
  const dbPath = opts.db
  const dbExists = fs.existsSync(dbPath)

  if (dbExists && !opts.fresh) {
    if (needsWizard) {
      const resume = await confirm({
        message: 'Found a previous export run. Resume it? (No = re-scan everything; already-exported data is not affected)',
        default: true,
      })
      if (!resume) fs.unlinkSync(dbPath)
    }
    // Non-TTY: auto-resume
  }
  if (opts.fresh && dbExists) fs.unlinkSync(dbPath)

  const db = createDatabase(dbPath)
  const queue = new UploadQueue(db)
  const manifest = new BlockManifest(db)

  if (dbExists && !opts.fresh) {
    const reset = queue.resetForRetry()
    if (reset > 0) log('INFO', `Reset ${reset} stuck/failed job(s) for retry`)
    const stats = queue.getStats()
    log('INFO', `Resuming: ${stats.complete} done, ${stats.pending} pending`)
  }

  // --- Collect sizes + enumerate ---
  await collectSpaceSizes(client, selectedSpaces, db)

  // Sort smallest first
  // ... [same logic as v1]

  // Enumerate and queue
  const batch: any[] = []
  for await (const upload of enumerateUploads(client, selectedSpaces)) {
    for (const be of backends) {
      batch.push({ rootCid: upload.rootCid, spaceDid: upload.spaceDid, spaceName: upload.spaceName, backend: be.name })
    }
    if (batch.length >= 500) { queue.addBatch(batch); batch.length = 0 }
  }
  if (batch.length > 0) queue.addBatch(batch)

  // --- Verify only? ---
  if (opts.verify) {
    const result = await runVerify({ queue, backends })
    log('INFO', `Verified: ${result.verified}, Failed: ${result.failed}`)
    db.close()
    return
  }

  // --- Export phase ---
  await runExport({
    queue, manifest, backends,
    gatewayUrl: opts.gateway,
    concurrency: opts.concurrency,
    spaceNames: selectedSpaces.map((s: any) => s.name),
  })

  // --- Verify phase ---
  log('INFO', 'Running verification...')
  const verifyResult = await runVerify({ queue, backends })
  log('INFO', `Verified: ${verifyResult.verified}, Failed: ${verifyResult.failed}`)

  // --- Farewell ---
  const finalStats = queue.getStats()
  if (finalStats.error === 0 && finalStats.pending === 0) {
    console.log('\n🐔 Cock-a-doodle-done! All exports verified.\n')
  } else if (finalStats.error > 0) {
    console.log(`\n${finalStats.error} failed exports. Re-run to retry.\n`)
  }

  db.close()
}
```

Note: This is a skeleton — the backend selection wizard and some plumbing will need filling in during implementation. The key structure is here.

- [ ] **Step 4: Create entry point**

Create `bin/storacha-export.js`:

```javascript
#!/usr/bin/env node
import '../dist/index.js'
```

Update `package.json`:

```json
{
  "bin": { "storacha-export": "./bin/storacha-export.js" },
  "version": "2.0.0"
}
```

- [ ] **Step 5: Run e2e tests**

```bash
npx vitest run test/e2e.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts src/index.ts bin/storacha-export.js test/e2e.test.ts package.json
git commit -m "feat: CLI with wizard, three-phase orchestration, auto-resume"
```

---

## Chunk 3: Integrated Dashboard

### Task 5: Dashboard HTML generator

**Files:**
- Create: `src/dashboard/html.ts`
- Create: `test/dashboard/html.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dashboard/html.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { generateDashboardHtml } from '../src/dashboard/html'

describe('generateDashboardHtml', () => {
  it('produces valid HTML with KPI cards', () => {
    const html = generateDashboardHtml({
      phase: 'export',
      pid: 12345,
      stats: { total: 10, complete: 5, error: 1, pending: 3, downloading: 1, partial: 0, repairing: 0, total_bytes: 50000 },
      bySpace: [
        { space_name: 'TestSpace', done: 5, errors: 1, pending: 3, active: 1, total: 10, bytes: 50000 },
      ],
      spaceSizes: new Map([['TestSpace', 100000]]),
      activeJobs: [{ space_name: 'TestSpace', root_cid: 'bafytest123', status: 'downloading' }],
      recentDone: [],
      recentErrors: [],
      logLines: ['2026-03-30 00:00:00 [12345] INFO test log line'],
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('storacha-export')
    expect(html).toContain('PID: 12345')
    expect(html).toContain('TestSpace')
    expect(html).toContain('Export')  // phase indicator
  })

  it('shows all three phases', () => {
    const base = {
      pid: 1, stats: { total: 0, complete: 0, error: 0, pending: 0, downloading: 0, partial: 0, repairing: 0, total_bytes: 0 },
      bySpace: [], spaceSizes: new Map(), activeJobs: [], recentDone: [], recentErrors: [], logLines: [],
    }

    expect(generateDashboardHtml({ ...base, phase: 'discovery' })).toContain('Discovery')
    expect(generateDashboardHtml({ ...base, phase: 'export' })).toContain('Export')
    expect(generateDashboardHtml({ ...base, phase: 'verify' })).toContain('Verify')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/dashboard/html.test.ts
```

- [ ] **Step 3: Implement HTML generator**

Create `src/dashboard/html.ts` — port the HTML/CSS from the v1 external `dashboard.js`, adapting to accept state as parameters rather than reading from DB. Add phase indicator, PID display, remove process status card.

(Full implementation omitted for brevity — port from v1's HTML generation with the phase header, per-upload status in active jobs, log panel with scroll-to-bottom.)

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/dashboard/html.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/html.ts test/dashboard/html.test.ts
git commit -m "feat: dashboard HTML generator with phase indicator and PID"
```

---

### Task 6: Dashboard HTTP server

**Files:**
- Create: `src/dashboard/server.ts`
- Create: `test/dashboard/server.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/dashboard/server.test.ts`:

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { startDashboard } from '../src/dashboard/server'
import type http from 'node:http'

describe('dashboard server', () => {
  let server: http.Server | null = null

  afterEach(async () => {
    if (server) await new Promise<void>(r => server!.close(() => r()))
    server = null
  })

  it('serves HTML on random port', async () => {
    const result = await startDashboard({
      host: '127.0.0.1',
      port: 0,
      getHtml: () => '<html><body>test</body></html>',
    })
    server = result.server
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const res = await fetch(result.url)
    const text = await res.text()
    expect(text).toContain('test')
  })

  it('enforces basic auth when password set', async () => {
    const result = await startDashboard({
      host: '127.0.0.1',
      port: 0,
      password: 'secret',
      getHtml: () => '<html>protected</html>',
    })
    server = result.server

    const noAuth = await fetch(result.url)
    expect(noAuth.status).toBe(401)

    const withAuth = await fetch(result.url, {
      headers: { Authorization: 'Basic ' + Buffer.from(':secret').toString('base64') },
    })
    expect(withAuth.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/dashboard/server.test.ts
```

- [ ] **Step 3: Implement server**

Create `src/dashboard/server.ts`:

```typescript
import http from 'node:http'

export interface DashboardOptions {
  host?: string
  port?: number
  password?: string
  getHtml: () => string
}

export async function startDashboard(options: DashboardOptions): Promise<{ server: http.Server; url: string }> {
  const { host = '127.0.0.1', port = 0, password, getHtml } = options

  const server = http.createServer((req, res) => {
    if (password) {
      const auth = req.headers.authorization
      const expected = 'Basic ' + Buffer.from(':' + password).toString('base64')
      if (auth !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="storacha-export"' })
        res.end('Unauthorized')
        return
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(getHtml())
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as { address: string; port: number }
      resolve({ server, url: `http://${addr.address}:${addr.port}` })
    })
  })
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run test/dashboard/server.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/server.ts test/dashboard/server.test.ts
git commit -m "feat: dashboard HTTP server with basic auth"
```

---

### Task 7: Wire dashboard into CLI + backend registry

**Files:**
- Create: `src/backends/registry.ts`
- Modify: `src/cli.ts` (wire in dashboard start/stop and HTML file writer)

- [ ] **Step 1: Create backend registry**

Create `src/backends/registry.ts`:

```typescript
import { KuboBackend } from './kubo'
import type { ExportBackend } from './interface'

export function createBackend(name: string, config: Record<string, any>): ExportBackend {
  switch (name) {
    case 'kubo':
      return new KuboBackend({ apiUrl: config.apiUrl })
    default:
      throw new Error(`Unknown backend: ${name}`)
  }
}
```

(Local and cluster backends added in Plan 3.)

- [ ] **Step 2: Wire dashboard into CLI**

Add to `src/cli.ts` in the appropriate places:
- Start dashboard server before export phase if `--serve` is set
- Set up `setInterval` for `--html-out`
- Maintain a log ring buffer (50 lines) fed by `onProgress`
- Pass `collectDashboardState()` to the server's `getHtml` callback
- Clean up on exit

- [ ] **Step 3: Run all tests**

```bash
npx vitest run
```

- [ ] **Step 4: Commit**

```bash
git add src/backends/registry.ts src/cli.ts
git commit -m "feat: backend registry and dashboard integration in CLI"
```

---

### Task 8: Final integration test

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

- [ ] **Step 2: Type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: v2 CLI + phases + dashboard complete"
```

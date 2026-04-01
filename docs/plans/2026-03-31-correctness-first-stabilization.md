# Correctness-First Stabilization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the unsupported `cluster` backend, make DAG verification authoritative for completion, and share gateway throttling across concurrent exports.

**Architecture:** Reduce the product surface to `local` and `kubo`. `verifyDag(rootCid)` becomes the only authority for moving an upload to `complete`; `hasContent()` is no longer trusted for correctness. `runExport()` owns one shared `GatewayFetcher` for the whole export session and passes it into every upload worker so 429 backoff is truly shared.

**Tech Stack:** TypeScript, Vitest, @ipld/car, @ipld/dag-pb, multiformats, better-sqlite3, undici

**Spec to Update:** `README.md`, `docs/design-v2.md`

**Worktree:** Before implementation, create an isolated worktree:

```bash
cd /Users/danny/Private/sync-priv/filecoin/storacha-transition/storacha-export
git worktree add ../storacha-export-correctness -b correctness-first-stabilization
cd ../storacha-export-correctness
```

---

### Task 1: Remove the `cluster` backend completely

**Files:**
- Delete: `src/backends/cluster.ts`
- Delete: `test/backends/cluster.test.ts`
- Create: `test/backends/registry.test.ts`
- Modify: `src/backends/registry.ts`
- Modify: `src/cli.ts`
- Modify: `README.md`

- [ ] **Step 1: Write the failing test**

Create `test/backends/registry.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { createBackend } from '../../src/backends/registry.js'

describe('createBackend', () => {
  it('rejects removed cluster backend', () => {
    expect(() => createBackend('cluster', {})).toThrow(/Unknown backend/)
  })
})
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run test/backends/registry.test.ts
```

Expected: FAIL because `createBackend('cluster', {})` still returns a backend.

- [ ] **Step 3: Remove the backend from code and CLI**

In `src/backends/registry.ts`, reduce the switch to only `kubo` and `local`:

```typescript
export function createBackend(name: string, config: Record<string, any>): ExportBackend {
  switch (name) {
    case 'kubo':
      return new KuboBackend({ apiUrl: config.apiUrl || 'http://127.0.0.1:5001' })
    case 'local':
      return new LocalBackend({ outputDir: config.outputDir || './export' })
    default:
      throw new Error(`Unknown backend: ${name}. Available: kubo, local`)
  }
}
```

In `src/cli.ts`:

1. Remove the `--cluster-api` option.
2. Remove `cluster` from the backend selection UI.
3. Remove the `cluster` configuration branch.

The CLI section should become:

```typescript
  .option('--backend <type...>', 'Backend(s): kubo, local')
  .option('--output <dir>', 'Output directory (local backend)')
  .option('--kubo-api <url>', 'Kubo API endpoint (URL or multiaddr)', 'http://127.0.0.1:5001')
```

and the wizard choices should become:

```typescript
choices: [
  { name: 'kubo — local IPFS node (dag/import)', value: 'kubo' },
  { name: 'local — save CAR files to disk', value: 'local' },
]
```

Then delete:

```text
src/backends/cluster.ts
test/backends/cluster.test.ts
```

Update `README.md` to remove:

1. The `cluster` backend section.
2. `--cluster-api` from the options table.
3. Any `cluster` examples or mentions.

- [ ] **Step 4: Run targeted verification**

```bash
npx vitest run test/backends/registry.test.ts test/backends/kubo.test.ts
npm exec tsc -- --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/registry.ts src/cli.ts README.md test/backends/registry.test.ts
git rm src/backends/cluster.ts test/backends/cluster.test.ts
git commit -m "refactor: remove unsupported cluster backend"
```

---

### Task 2: Make local DAG verification prove completeness

**Files:**
- Modify: `src/backends/local.ts`
- Modify: `test/backends/local.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `test/backends/local.test.ts` inside `describe('LocalBackend', ...)`:

```typescript
  it('verifyDag rejects a parseable CAR that is missing reachable blocks', async () => {
    const leaf = await makeRawBlock('missing-leaf')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()

    // This CAR is syntactically valid but incomplete: it contains only the root.
    const incompleteCar = await buildCarBytes([root], [root])
    fs.writeFileSync(path.join(tmpDir, `${rootCid}.car`), incompleteCar)

    const result = await backend.verifyDag(rootCid)

    expect(result.valid).toBe(false)
    expect(result.error).toContain(leaf.cid.toString().slice(0, 16))
  })
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: FAIL because the current `verifyDag()` only checks that the CAR parses.

- [ ] **Step 3: Implement reachability-based verification**

In `src/backends/local.ts`, change `verifyDag()` so it:

1. Loads every block from the CAR into a `Map<string, Uint8Array>`.
2. Starts traversal from the `rootCid` argument.
3. Requires every reachable linked CID to exist in the map.
4. Decodes `dag-pb` blocks and pushes their links onto the traversal stack.
5. Returns a descriptive error when a reachable block is missing.

Add the import:

```typescript
import * as dagPB from '@ipld/dag-pb'
```

Use this implementation shape:

```typescript
  async verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }> {
    const filePath = this.carPath(rootCid)
    if (!fs.existsSync(filePath)) {
      return { valid: false, error: 'CAR file not found' }
    }

    try {
      const stream = fs.createReadStream(filePath)
      const iterator = await CarBlockIterator.fromIterable(stream)
      const blocks = new Map<string, Uint8Array>()

      for await (const { cid, bytes } of iterator) {
        blocks.set(cid.toString(), bytes)
      }

      if (!blocks.has(rootCid)) {
        return { valid: false, error: `Root block missing: ${rootCid}` }
      }

      const stack = [rootCid]
      const visited = new Set<string>()

      while (stack.length > 0) {
        const cidStr = stack.pop()!
        if (visited.has(cidStr)) continue
        visited.add(cidStr)

        const bytes = blocks.get(cidStr)
        if (!bytes) {
          return { valid: false, error: `Missing reachable block: ${cidStr}` }
        }

        const cid = CID.parse(cidStr)
        if (cid.code === 0x70) {
          const node = dagPB.decode(bytes)
          for (const link of node.Links) {
            stack.push(link.Hash.toString())
          }
        }
      }

      return { valid: true }
    } catch (err: any) {
      return { valid: false, error: err.message }
    }
  }
```

- [ ] **Step 4: Run targeted verification**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: PASS, including the new incomplete-CAR test.

- [ ] **Step 5: Commit**

```bash
git add src/backends/local.ts test/backends/local.test.ts
git commit -m "fix: make local verifyDag validate full DAG reachability"
```

---

### Task 3: Make `verifyDag()` the only completion authority and remove the startup sweep

**Files:**
- Modify: `src/backends/interface.ts`
- Modify: `src/core/pipeline.ts`
- Modify: `src/phases/verify.ts`
- Modify: `src/cli.ts`
- Modify: `test/core/pipeline.test.ts`
- Modify: `test/phases/verify.test.ts`
- Modify: `test/phases/export.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this test to `test/core/pipeline.test.ts`:

```typescript
class LyingBackend implements ExportBackend {
  name = 'lying'
  imported = false

  async importCar(_rootCid: string, stream: any): Promise<void> {
    for await (const _chunk of stream) {}
    this.imported = true
  }

  async hasContent(): Promise<boolean> {
    return true
  }

  async verifyDag(): Promise<{ valid: boolean; error?: string }> {
    return this.imported
      ? { valid: true }
      : { valid: false, error: 'file exists but DAG is incomplete' }
  }
}

it('does not trust hasContent alone when deciding completion', async () => {
  const leaf = await makeRawBlock('hello')
  const root = await makeDagPBNode([leaf])
  const carBytes = await buildCarBytes([root, leaf], [root])

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.ipld.car' })
    res.end(carBytes)
  })
  await new Promise<void>(resolve => server.listen(0, resolve))
  const gatewayUrl = `http://127.0.0.1:${(server.address() as any).port}`

  const backend = new LyingBackend()
  queue.add({ rootCid: root.cid.toString(), spaceDid: 'did:key:test', spaceName: 'Test', backend: 'lying' })

  await exportUpload({
    rootCid: root.cid.toString(),
    backend,
    queue,
    manifest,
    gatewayUrl,
  })

  expect(backend.imported).toBe(true)
  expect(queue.getStatus(root.cid.toString(), 'lying')).toBe('complete')
  await new Promise<void>(resolve => server.close(() => resolve()))
})
```

Replace the fallback test in `test/phases/verify.test.ts` with:

```typescript
  it('uses verifyDag as the source of truth during verification', async () => {
    queue.add({ rootCid: 'bafyA', spaceDid: 'did:key:test', spaceName: 'S1', backend: 'mock' })
    queue.markComplete('bafyA', 'mock', 100)

    let verifyCalls = 0
    const backend: ExportBackend = {
      name: 'mock',
      async importCar() {},
      async hasContent() { return true },
      async verifyDag() {
        verifyCalls++
        return { valid: false, error: 'missing blocks' }
      },
    }

    const result = await runVerify({ queue, backends: [backend] })
    expect(verifyCalls).toBe(1)
    expect(result.failed).toBe(1)
    expect(queue.getStatus('bafyA', 'mock')).toBe('partial')
  })
```

Update the `MemoryBackend` in `test/phases/export.test.ts` to include:

```typescript
  async verifyDag(rootCid: string) {
    return this.pinned.has(rootCid)
      ? { valid: true }
      : { valid: false, error: 'not pinned' }
  }
```

- [ ] **Step 2: Run the targeted tests and verify failure**

```bash
npx vitest run test/core/pipeline.test.ts test/phases/verify.test.ts test/phases/export.test.ts
```

Expected: FAIL because `exportUpload()` still short-circuits on `hasContent()`.

- [ ] **Step 3: Implement the contract change**

In `src/backends/interface.ts`, make `verifyDag` required:

```typescript
export interface ExportBackend {
  name: string
  init?(): Promise<void>
  close?(): Promise<void>
  importCar(rootCid: string, stream: BlockStream | AsyncIterable<Uint8Array> | NodeJS.ReadableStream): Promise<void>
  hasContent?(rootCid: string): Promise<boolean>
  hasBlock?(cid: string): Promise<boolean>
  putBlock?(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void>
  verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }>
}
```

In `src/core/pipeline.ts`, remove all completion decisions based on `hasContent()`. At the top of `exportUpload()`, replace:

```typescript
  if (await backend.hasContent(rootCid)) {
    queue.markComplete(rootCid, backend.name, 0)
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    log('INFO', `${tag} Already pinned in ${backend.name}`)
    return
  }
```

with:

```typescript
  const initialCheck = await backend.verifyDag(rootCid)
  if (initialCheck.valid) {
    queue.markComplete(rootCid, backend.name, 0)
    onProgress?.({ type: 'done', rootCid, bytes: 0 })
    log('INFO', `${tag} Already complete in ${backend.name}`)
    return
  }
```

After `importCar()` and after repair completion, replace `hasContent()` checks with:

```typescript
      const verifyResult = await backend.verifyDag(rootCid)
      if (verifyResult.valid) {
        queue.markComplete(rootCid, backend.name, byteCount)
        onProgress?.({ type: 'done', rootCid, bytes: byteCount })
        return
      }

      queue.setStatus(rootCid, backend.name, 'partial')
      lastError = new Error(verifyResult.error || 'DAG verification failed after import')
      break
```

and similarly in the repair path:

```typescript
        const verifyResult = await backend.verifyDag(rootCid)
        if (verifyResult.valid) {
          queue.markComplete(rootCid, backend.name, 0)
          onProgress?.({ type: 'done', rootCid, bytes: 0 })
          log('REPAIR', `${tag} Repaired and verified`)
          return
        }
```

In `src/phases/verify.ts`, remove the fallback branch and always call `verifyDag()`:

```typescript
        const result = await backend.verifyDag(upload.root_cid)
        const valid = result.valid
        const error = result.error
```

In `src/cli.ts`, delete the entire startup sweep block that scans backends for existing content before export:

```typescript
  // --- Quick sweep: check which root CIDs the backend already has ---
  ...
```

After removing it, the export flow should go directly from enumeration to either `--verify` or `runExport()`.

- [ ] **Step 4: Run targeted verification**

```bash
npx vitest run test/core/pipeline.test.ts test/phases/verify.test.ts test/phases/export.test.ts
npm exec tsc -- --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/backends/interface.ts src/core/pipeline.ts src/phases/verify.ts src/cli.ts test/core/pipeline.test.ts test/phases/verify.test.ts test/phases/export.test.ts
git commit -m "fix: make verifyDag authoritative for completion"
```

---

### Task 4: Share one `GatewayFetcher` across the export session

**Files:**
- Modify: `src/phases/export.ts`
- Modify: `src/core/pipeline.ts`
- Modify: `test/phases/export.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test to `test/phases/export.test.ts`:

```typescript
  it('creates one GatewayFetcher per export run and reuses it for every upload', async () => {
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
        res.writeHead(404)
        res.end()
      }
    })
    await new Promise<void>(resolve => server.listen(0, resolve))
    const gatewayUrl = `http://127.0.0.1:${(server.address() as any).port}`

    const backend = new MemoryBackend()
    queue.add({ rootCid: root1.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })
    queue.add({ rootCid: root2.cid.toString(), spaceDid: 'did:key:test', spaceName: 'TestSpace', backend: 'memory' })

    let createFetcherCalls = 0

    await runExport({
      queue,
      manifest,
      backends: [backend],
      gatewayUrl,
      concurrency: 2,
      spaceNames: ['TestSpace'],
      createFetcher: (url) => {
        createFetcherCalls++
        return new GatewayFetcher(url)
      },
    })

    expect(createFetcherCalls).toBe(1)
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
npx vitest run test/phases/export.test.ts
```

Expected: FAIL because `runExport()` does not yet accept or use `createFetcher`.

- [ ] **Step 3: Thread a shared fetcher through the export path**

In `src/core/pipeline.ts`, change the options type to accept a shared fetcher:

```typescript
import { GatewayFetcher } from './fetcher.js'

export interface ExportUploadOptions {
  rootCid: string
  backend: ExportBackend
  queue: UploadQueue
  manifest: BlockManifest
  fetcher: GatewayFetcher
  gatewayUrl: string
  maxRetries?: number
  uploadTimeout?: number
  onProgress?: (info: { type: string; [key: string]: any }) => void
}
```

Then delete:

```typescript
  const fetcher = new GatewayFetcher(gatewayUrl)
```

and use `options.fetcher` throughout.

In `src/phases/export.ts`, add a fetcher factory hook and create exactly one instance per run:

```typescript
import { GatewayFetcher } from '../core/fetcher.js'

export interface ExportOptions {
  queue: UploadQueue
  manifest: BlockManifest
  backends: ExportBackend[]
  gatewayUrl: string
  concurrency?: number
  spaceNames?: string[]
  createFetcher?: (gatewayUrl: string) => GatewayFetcher
  onProgress?: (info: { type: string; [key: string]: any }) => void
}

export async function runExport(options: ExportOptions): Promise<void> {
  const {
    queue,
    manifest,
    backends,
    gatewayUrl,
    concurrency = 1,
    spaceNames,
    createFetcher = (url) => new GatewayFetcher(url),
    onProgress,
  } = options

  const fetcher = createFetcher(gatewayUrl)

  // inside worker():
  await exportUpload({
    rootCid: upload.root_cid,
    backend,
    queue,
    manifest,
    fetcher,
    gatewayUrl,
    onProgress: onProgress && ((info) => onProgress({ ...info, spaceName: upload.space_name })),
  })
}
```

Update the comment in `src/core/fetcher.ts` so it is finally true: the gate is shared because one `GatewayFetcher` is shared across the export session.

- [ ] **Step 4: Run targeted verification**

```bash
npx vitest run test/phases/export.test.ts test/core/fetcher.test.ts
npm exec tsc -- --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/phases/export.ts src/core/pipeline.ts src/core/fetcher.ts test/phases/export.test.ts
git commit -m "fix: share gateway fetcher across export workers"
```

---

### Task 5: Update the docs and run the full verification pass

**Files:**
- Modify: `README.md`
- Modify: `docs/design-v2.md`

- [ ] **Step 1: Update the docs**

In `README.md`:

1. Remove all `cluster` references.
2. Remove `--cluster-api`.
3. Update the “Backends” section so it describes only `local` and `kubo`.
4. Update any wording that implies file existence or root pin existence is enough for correctness.

In `docs/design-v2.md`:

1. Remove the `cluster` backend section.
2. Update the backend interface so `verifyDag()` is required.
3. Remove `--dry-run` if it is still mentioned.
4. Update the export flow description so `verifyDag()` is the completion gate.
5. Update the concurrency section to say one shared fetch coordinator is used for the run.

The backend interface section should become:

```typescript
interface ExportBackend {
  name: string
  init?(): Promise<void>
  close?(): Promise<void>
  importCar(rootCid: string, blocks: BlockStream): Promise<void>
  hasContent?(rootCid: string): Promise<boolean>
  hasBlock?(cid: string): Promise<boolean>
  putBlock?(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void>
  verifyDag(rootCid: string): Promise<{ valid: boolean; error?: string }>
}
```

- [ ] **Step 2: Run the full verification pass**

If `better-sqlite3` fails to load because Node has changed, rebuild it first:

```bash
npm rebuild better-sqlite3
```

Then run:

```bash
npm exec tsc -- --noEmit --noUnusedLocals --noUnusedParameters
npm run build
npx vitest run test/backends/local.test.ts test/backends/kubo.test.ts test/backends/registry.test.ts test/core/fetcher.test.ts test/core/pipeline.test.ts test/phases/export.test.ts test/phases/verify.test.ts
```

Expected: PASS.

- [ ] **Step 3: Sanity-check that `cluster` is gone from product code**

```bash
rg -n "cluster|cluster-api" src test README.md docs/design-v2.md
```

Expected:

1. No matches in `src/`
2. No matches in `test/`
3. No product-surface matches in `README.md`
4. Only historical references in old archived plan documents, if any

- [ ] **Step 4: Commit**

```bash
git add README.md docs/design-v2.md
git commit -m "docs: align design and README with correctness-first backend model"
```


# Local Backend Repair via Sidecar CAR

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the local backend's broken custom repair with `putBlock` that writes to a per-root `.car.repair` sidecar CAR, plus a merge step that produces a deduplicated final CAR.

**Architecture:** Add `rootCid` parameter to `putBlock` interface. Local backend writes repair blocks to `{rootCid}.car.repair` using a `CarWriter` kept open for the duration of repair. When repair completes, `mergeRepairCar` reads both files, deduplicates by CID, and writes a clean replacement. Remove the old custom `repair()` method.

**Tech Stack:** @ipld/car (CarWriter, CarBlockIterator), node:fs, vitest

**Branch:** `v2`

---

## Task 1: Add `rootCid` to `putBlock` interface

**Files:**
- Modify: `src/backends/interface.ts`
- Modify: `src/backends/kubo.ts`
- Modify: `src/core/pipeline.ts`

- [ ] **Step 1: Update the interface**

In `src/backends/interface.ts`, change:

```typescript
  /** Store an individual block */
  putBlock?(cid: string, bytes: Uint8Array): Promise<void>
```

to:

```typescript
  /** Store an individual block (rootCid identifies which upload this belongs to) */
  putBlock?(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void>
```

- [ ] **Step 2: Update kubo backend signature**

In `src/backends/kubo.ts`, change the `putBlock` signature to match:

```typescript
  async putBlock(cid: string, bytes: Uint8Array, _rootCid?: string): Promise<void> {
```

(Body unchanged — kubo ignores rootCid.)

- [ ] **Step 3: Update pipeline to pass rootCid**

In `src/core/pipeline.ts`, find both `onBlock` callbacks (there are two — the resume-repair path and the inline-repair path) and change:

```typescript
onBlock: backend.putBlock ? async (block) => { await backend.putBlock!(block.cid.toString(), block.bytes) } : undefined,
```

to:

```typescript
onBlock: backend.putBlock ? async (block) => { await backend.putBlock!(block.cid.toString(), block.bytes, rootCid) } : undefined,
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run
```

Expected: all tests pass (no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add src/backends/interface.ts src/backends/kubo.ts src/core/pipeline.ts
git commit -m "refactor: add rootCid param to putBlock interface"
```

---

## Task 2: Implement `putBlock` on local backend with sidecar CAR

**Files:**
- Modify: `src/backends/local.ts`
- Modify: `test/backends/local.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/backends/local.test.ts` inside the existing `describe('LocalBackend', ...)` block:

```typescript
  it('putBlock writes a block to a .car.repair sidecar', async () => {
    const leaf = await makeRawBlock('put-test')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()

    // Write initial CAR (root only)
    async function* rootBlocks(): AsyncIterable<Block> { yield root }
    await backend.importCar(rootCid, rootBlocks())

    // putBlock should create .car.repair
    await backend.putBlock!(leaf.cid.toString(), leaf.bytes, rootCid)
    await backend.closeRepairWriter(rootCid)

    const repairPath = path.join(tmpDir, `${rootCid}.car.repair`)
    expect(fs.existsSync(repairPath)).toBe(true)

    // .car.repair should be a valid CAR containing the leaf
    const data = fs.readFileSync(repairPath)
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(data) })()
    )
    const repairBlocks: any[] = []
    for await (const b of iter) repairBlocks.push(b)
    expect(repairBlocks).toHaveLength(1)
    expect(repairBlocks[0].cid.toString()).toBe(leaf.cid.toString())
  })

  it('putBlock appends multiple blocks to the same sidecar', async () => {
    const leaf1 = await makeRawBlock('multi-1')
    const leaf2 = await makeRawBlock('multi-2')
    const root = await makeDagPBNode([leaf1, leaf2])
    const rootCid = root.cid.toString()

    async function* rootBlocks(): AsyncIterable<Block> { yield root }
    await backend.importCar(rootCid, rootBlocks())

    await backend.putBlock!(leaf1.cid.toString(), leaf1.bytes, rootCid)
    await backend.putBlock!(leaf2.cid.toString(), leaf2.bytes, rootCid)
    await backend.closeRepairWriter(rootCid)

    const repairPath = path.join(tmpDir, `${rootCid}.car.repair`)
    const data = fs.readFileSync(repairPath)
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(data) })()
    )
    const repairBlocks: any[] = []
    for await (const b of iter) repairBlocks.push(b)
    expect(repairBlocks).toHaveLength(2)
  })
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: FAIL — `putBlock` and `closeRepairWriter` not defined.

- [ ] **Step 3: Implement `putBlock` and `closeRepairWriter`**

In `src/backends/local.ts`, add a map of open repair writers and two new methods:

```typescript
  private repairWriters = new Map<string, {
    writer: ReturnType<typeof CarWriter.create>['writer']
    drainPromise: Promise<void>
  }>()

  async putBlock(cid: string, bytes: Uint8Array, rootCid?: string): Promise<void> {
    if (!rootCid) throw new Error('putBlock requires rootCid for local backend')

    if (!this.repairWriters.has(rootCid)) {
      const repairPath = this.carPath(rootCid) + '.repair'
      fs.mkdirSync(this.outputDir, { recursive: true })
      const rootCidObj = CID.parse(rootCid)
      const { writer, out } = CarWriter.create([rootCidObj])
      const fileStream = fs.createWriteStream(repairPath)
      const drainPromise = (async () => {
        for await (const chunk of out) fileStream.write(chunk)
        fileStream.end()
        await new Promise<void>((resolve, reject) => {
          fileStream.on('finish', resolve)
          fileStream.on('error', reject)
        })
      })()
      this.repairWriters.set(rootCid, { writer, drainPromise })
    }

    const { writer } = this.repairWriters.get(rootCid)!
    const cidObj = CID.parse(cid)
    await writer.put({ cid: cidObj, bytes })
  }

  async closeRepairWriter(rootCid: string): Promise<void> {
    const entry = this.repairWriters.get(rootCid)
    if (!entry) return
    await entry.writer.close()
    await entry.drainPromise
    this.repairWriters.delete(rootCid)
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backends/local.ts test/backends/local.test.ts
git commit -m "feat: local putBlock writes to .car.repair sidecar via CarWriter"
```

---

## Task 3: Implement `mergeRepairCar`

**Files:**
- Modify: `src/backends/local.ts`
- Modify: `test/backends/local.test.ts`

- [ ] **Step 1: Write the failing test**

Add a new describe block to `test/backends/local.test.ts`:

```typescript
describe('LocalBackend mergeRepairCar', () => {
  let tmpDir: string
  let backend: LocalBackend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-local-merge-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('merges main CAR and repair sidecar into a deduplicated CAR', async () => {
    const leaf1 = await makeRawBlock('merge-1')
    const leaf2 = await makeRawBlock('merge-2')
    const leaf3 = await makeRawBlock('merge-3')
    const root = await makeDagPBNode([leaf1, leaf2, leaf3])
    const rootCid = root.cid.toString()

    // Write main CAR with root + leaf1
    const mainCar = await buildCarBytes([root, leaf1], [root])
    fs.writeFileSync(path.join(tmpDir, `${rootCid}.car`), mainCar)

    // Write repair sidecar with leaf1 (duplicate) + leaf2 + leaf3
    await backend.putBlock!(leaf1.cid.toString(), leaf1.bytes, rootCid)
    await backend.putBlock!(leaf2.cid.toString(), leaf2.bytes, rootCid)
    await backend.putBlock!(leaf3.cid.toString(), leaf3.bytes, rootCid)
    await backend.closeRepairWriter(rootCid)

    // Merge
    await backend.mergeRepairCar(rootCid)

    // .car.repair should be gone
    expect(fs.existsSync(path.join(tmpDir, `${rootCid}.car.repair`))).toBe(false)

    // Final CAR should have exactly 4 blocks (deduplicated)
    const finalData = fs.readFileSync(path.join(tmpDir, `${rootCid}.car`))
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(finalData) })()
    )
    const cids = new Set<string>()
    for await (const b of iter) cids.add(b.cid.toString())
    expect(cids.size).toBe(4)
    expect(cids.has(root.cid.toString())).toBe(true)
    expect(cids.has(leaf1.cid.toString())).toBe(true)
    expect(cids.has(leaf2.cid.toString())).toBe(true)
    expect(cids.has(leaf3.cid.toString())).toBe(true)
  })

  it('mergeRepairCar is a no-op when no sidecar exists', async () => {
    const leaf = await makeRawBlock('noop-test')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()

    const mainCar = await buildCarBytes([root, leaf], [root])
    const carPath = path.join(tmpDir, `${rootCid}.car`)
    fs.writeFileSync(carPath, mainCar)

    const sizeBefore = fs.statSync(carPath).size
    await backend.mergeRepairCar(rootCid)
    const sizeAfter = fs.statSync(carPath).size
    expect(sizeAfter).toBe(sizeBefore)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: FAIL — `mergeRepairCar` not defined.

- [ ] **Step 3: Implement `mergeRepairCar`**

Add to `src/backends/local.ts`:

```typescript
  async mergeRepairCar(rootCid: string): Promise<void> {
    const mainPath = this.carPath(rootCid)
    const repairPath = mainPath + '.repair'

    if (!fs.existsSync(repairPath)) return

    // Close any open writer for this root
    await this.closeRepairWriter(rootCid)

    // Read all blocks from both files, deduplicate by CID
    const blocks = new Map<string, Block>()

    // Read main CAR
    if (fs.existsSync(mainPath)) {
      try {
        const stream = fs.createReadStream(mainPath)
        const iter = await CarBlockIterator.fromIterable(stream)
        for await (const block of iter) {
          blocks.set(block.cid.toString(), block)
        }
      } catch {
        // Truncated main CAR — got what we got
      }
    }

    // Read repair sidecar
    try {
      const stream = fs.createReadStream(repairPath)
      const iter = await CarBlockIterator.fromIterable(stream)
      for await (const block of iter) {
        blocks.set(block.cid.toString(), block)
      }
    } catch {
      // Truncated repair CAR — got what we got
    }

    // Write merged CAR
    const tempPath = mainPath + '.merge'
    const rootCidObj = CID.parse(rootCid)
    const { writer, out } = CarWriter.create([rootCidObj])
    const fileStream = fs.createWriteStream(tempPath)
    const drain = (async () => {
      for await (const chunk of out) fileStream.write(chunk)
      fileStream.end()
      await new Promise<void>((resolve, reject) => {
        fileStream.on('finish', resolve)
        fileStream.on('error', reject)
      })
    })()

    for (const block of blocks.values()) {
      await writer.put(block)
    }
    await writer.close()
    await drain

    // Atomic replace
    fs.renameSync(tempPath, mainPath)
    fs.unlinkSync(repairPath)
    log('REPAIR', `[local] Merged ${blocks.size} blocks into ${rootCid.slice(0, 24)}...`)
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backends/local.ts test/backends/local.test.ts
git commit -m "feat: mergeRepairCar deduplicates main + sidecar into clean CAR"
```

---

## Task 4: Remove old `repair()` method, wire merge into pipeline

**Files:**
- Modify: `src/backends/local.ts`
- Modify: `src/core/pipeline.ts`
- Modify: `test/backends/local.test.ts`

- [ ] **Step 1: Remove the old `repair()` method from local backend**

In `src/backends/local.ts`, delete the entire `async repair(...)` method (lines 88-154 approximately).

- [ ] **Step 2: Update the old repair test**

Replace the `describe('LocalBackend repair', ...)` block in `test/backends/local.test.ts` with a test that exercises the new flow (putBlock + merge):

```typescript
describe('LocalBackend repair flow', () => {
  let tmpDir: string
  let backend: LocalBackend

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'storacha-v2-local-repair-'))
    backend = new LocalBackend({ outputDir: tmpDir })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('full repair flow: import truncated CAR, putBlock missing, merge', async () => {
    const leaf1 = await makeRawBlock('data-1')
    const leaf2 = await makeRawBlock('data-2')
    const leaf3 = await makeRawBlock('data-3')
    const root = await makeDagPBNode([leaf1, leaf2, leaf3])
    const rootCid = root.cid.toString()

    // Simulate truncated download (root + leaf1 only)
    const truncatedCar = await buildCarBytes([root, leaf1], [root])
    fs.writeFileSync(path.join(tmpDir, `${rootCid}.car`), truncatedCar)

    // Simulate repair: putBlock for missing leaves
    await backend.putBlock!(leaf2.cid.toString(), leaf2.bytes, rootCid)
    await backend.putBlock!(leaf3.cid.toString(), leaf3.bytes, rootCid)

    // Merge
    await backend.mergeRepairCar(rootCid)

    // Verify: 4 unique blocks, valid CAR
    const result = await backend.verifyDag!(rootCid)
    expect(result.valid).toBe(true)

    const data = fs.readFileSync(path.join(tmpDir, `${rootCid}.car`))
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(data) })()
    )
    const cids = new Set<string>()
    for await (const b of iter) cids.add(b.cid.toString())
    expect(cids.size).toBe(4)
  })
})
```

- [ ] **Step 3: Wire merge into pipeline after repair completes**

In `src/core/pipeline.ts`, after each repair path that calls `putBlock`, add a merge call. Find both places where repair completes successfully (the `if (result && result.complete)` blocks) and add:

```typescript
      // Merge repair sidecar for local backend
      if ('mergeRepairCar' in backend) {
        await (backend as any).mergeRepairCar(rootCid)
      }
```

Add this just before the `if (await backend.hasContent(rootCid))` check in both the resume-repair and inline-repair paths.

Also remove the `backend.repair` delegation code that was added in the previous commit — the two blocks that start with `if (backend.repair)`. The local backend no longer has a `repair()` method.

- [ ] **Step 4: Run all tests**

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/backends/local.ts src/core/pipeline.ts test/backends/local.test.ts
git commit -m "feat: wire local repair via putBlock + mergeRepairCar, remove old repair()"
```

---

## Task 5: Add `close()` to flush open writers on shutdown

**Files:**
- Modify: `src/backends/local.ts`
- Modify: `test/backends/local.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe('LocalBackend', ...)` block:

```typescript
  it('close() flushes any open repair writers', async () => {
    const leaf = await makeRawBlock('close-test')
    const root = await makeDagPBNode([leaf])
    const rootCid = root.cid.toString()

    async function* rootBlocks(): AsyncIterable<Block> { yield root }
    await backend.importCar(rootCid, rootBlocks())

    await backend.putBlock!(leaf.cid.toString(), leaf.bytes, rootCid)
    // Don't call closeRepairWriter — close() should handle it
    await backend.close!()

    const repairPath = path.join(tmpDir, `${rootCid}.car.repair`)
    expect(fs.existsSync(repairPath)).toBe(true)

    // Should be a valid, complete CAR
    const data = fs.readFileSync(repairPath)
    const iter = await CarBlockIterator.fromIterable(
      (async function* () { yield new Uint8Array(data) })()
    )
    const blocks: any[] = []
    for await (const b of iter) blocks.push(b)
    expect(blocks).toHaveLength(1)
  })
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: FAIL — `close()` not defined or doesn't flush writers.

- [ ] **Step 3: Implement `close()`**

Add to `src/backends/local.ts`:

```typescript
  async close(): Promise<void> {
    for (const rootCid of this.repairWriters.keys()) {
      await this.closeRepairWriter(rootCid)
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/backends/local.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Run full test suite**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all tests pass, no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/backends/local.ts test/backends/local.test.ts
git commit -m "feat: local close() flushes open repair writers"
```

---

## Task 6: Clean up — remove `repair()` from interface if unused

**Files:**
- Modify: `src/backends/interface.ts`
- Modify: `src/core/pipeline.ts`

- [ ] **Step 1: Check if any backend still implements `repair()`**

```bash
grep -rn "async repair(" src/backends/
```

If no backends implement it, remove from the interface.

- [ ] **Step 2: Remove `repair()` from interface**

In `src/backends/interface.ts`, remove:

```typescript
  /** Override repair strategy entirely */
  repair?(rootCid: string, manifest: BlockManifest, fetchBlock: (cid: string) => Promise<Block>): Promise<boolean>
```

Also remove the unused `BlockManifest` import if it was only used for `repair`.

- [ ] **Step 3: Remove `backend.repair` checks from pipeline**

In `src/core/pipeline.ts`, remove the `if (backend.repair)` blocks in both repair paths. The generic repair via `putBlock` is now the only path.

- [ ] **Step 4: Run full test suite**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all tests pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/backends/interface.ts src/core/pipeline.ts
git commit -m "chore: remove unused repair() from backend interface"
```

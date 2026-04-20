# Multi-Backend Fan-Out

Stream blocks to multiple backends simultaneously from a single gateway download.

## Problem

With `--backend kubo local`, the export processes each backend sequentially — downloading every upload from the gateway twice. For 10,474 DataCivica uploads hitting rate limits, this doubles an already slow process.

## Design

### Byte-stream tee in the pipeline

`exportUpload()` currently tees the raw CAR byte stream into two PassThrough streams: one for the backend and one for block tracking. We extend this to N backends.

**Changes to `exportUpload()`:**

- Accept `backends: ExportBackend[]` instead of `backend: ExportBackend`.
- Fork `countingStream` into one PassThrough per backend, each piped to that backend's `importCar()`.
- `Promise.all` the backend imports so they run concurrently.
- During repair, `onBlock` calls `putBlock` on every backend that supports it.
- Queue status updates (`markComplete`, `markError`, `setStatus`) apply per backend independently — the queue already keys on `(root_cid, backend)`.
- Verification runs per backend; an upload is only fully done when all backends verify.

**Changes to `runExport()`:**

- Instead of `for (const backend of backends)`, pass all backends into each `exportUpload()` call.
- Pending list: union of uploads pending for any backend. Skip backends where an upload is already complete.

### Repair fan-out

The repair path calls `backend.putBlock()` for each fetched block. With multiple backends, it calls `putBlock` on all backends that support it. For the local backend's `mergeRepairCar`, call it on any backend that has it.

### Verification

After import or repair, verify each backend independently. An upload is complete when all backends verify. If one backend fails verification but another succeeds, mark the failing one as partial (it will get repaired on re-run).

### Queue semantics

No schema changes. The queue already tracks `(root_cid, backend)` pairs. A single `exportUpload` call updates multiple queue rows. The pending list query becomes: uploads pending for *any* of the active backends.

## Scope

- Pipeline fan-out for CAR import and repair
- No changes to backend interface
- No changes to DB schema
- No changes to dashboard or CLI args (existing `--backend kubo local` syntax works)

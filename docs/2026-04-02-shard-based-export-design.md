# Shard-Based Export Design

## Summary

Replace full-DAG gateway fetches with individual ≤128MB blob shard fetches.
Storacha's upload client already splits DAGs into CAR shards at upload time;
we fetch those directly instead of asking the gateway to reconstruct the
entire DAG as one CAR (which times out on large uploads).

## Approach

Shard path runs alongside the existing full-DAG path (Approach B). Uploads
with shard records in the DB use the new path; uploads without them fall back
to the old path. Once validated, the old path can be removed.

## Database Schema

Two new tables:

### `blobs`

Raw blob inventory from `blob.list()`. Each blob's `digest` field is the
raw multihash bytes (Uint8Array) from the Storacha API, stored hex-encoded.
The `cid` is the raw-codec CIDv1 computed from that digest — it is NOT NULL
because it serves as the join key to `shards.shard_cid`.

    CREATE TABLE IF NOT EXISTS blobs (
      digest TEXT NOT NULL,
      size INTEGER NOT NULL,
      space_did TEXT NOT NULL,
      cid TEXT NOT NULL,
      is_index INTEGER DEFAULT 0,
      fetched INTEGER DEFAULT 0,
      inserted_at TEXT,
      PRIMARY KEY (digest, space_did)
    );

### `shards`

Parsed upload→shard mapping from index blobs. `shard_cid` is the same CID
stored in `blobs.cid` — the join path is:
`uploads.root_cid → shards.upload_root → shards.shard_cid → blobs.cid`.

    CREATE TABLE IF NOT EXISTS shards (
      upload_root TEXT NOT NULL,
      shard_cid TEXT NOT NULL,
      shard_size INTEGER,
      shard_order INTEGER NOT NULL,
      space_did TEXT NOT NULL,
      PRIMARY KEY (upload_root, shard_cid)
    );
    CREATE INDEX IF NOT EXISTS idx_shards_root ON shards(upload_root);

## Discover Phase

Runs after existing upload enumeration but before export, on every run
(so a crash between enumeration and blob discovery does not strand uploads
on the slow full-DAG path).

1. For each space, call `client.setCurrentSpace(space.did)`, then
   `client.capability.blob.list({ size: 1000 })` with cursor pagination.
2. For each blob, compute the raw CID from `blob.digest` (a Uint8Array
   multihash). Parse the varint-encoded multihash prefix to extract the
   hash code and digest bytes, rather than assuming a fixed 2-byte prefix.
   Assert that the hash code is 0x12 (sha2-256); log a warning and skip
   if not. Build the CID: `CID.createV1(0x55, createDigest(code, hash))`.
3. Insert into `blobs` table. Skip already-known blobs (resume-friendly).
4. Identify candidate index blobs: query `blobs` where `fetched = 0` and
   `size < 200000` (200KB threshold — observed indexes range from ~380
   bytes to ~80KB; data shards start at tens of MB).
5. Fetch each candidate from `dag.w3s.link/ipfs/{cid}?format=raw`. Note:
   `?format=raw` here returns the raw blob content, which for index blobs
   is a small CAR file containing dag-cbor blocks.
6. Parse as CAR, decode the root block as dag-cbor. If it contains the key
   `index/sharded/dag@0.1`, it is an index — set `is_index = 1` and
   extract the `content` (upload root CID) and `shards` (shard CID list).
7. If parsing fails (corrupt CAR, unexpected codec, missing fields), log a
   warning, mark `fetched = 1` to avoid retrying, and continue. The
   upload will fall back to the full-DAG path since it has no shard records.
8. Insert rows into `shards` table with ordering preserved.
9. Join against `blobs` on `shards.shard_cid = blobs.cid` to populate
   `shards.shard_size`.
10. Mark all fetched blobs as `fetched = 1`.

This runs as a new function (e.g., `discoverShards(client, db, fetcher)`)
called from `cli.ts` after `enumerateUploads` completes and before the
export phase begins. Progress logged per-space: "Space X: N blobs, M
indexes parsed, K multi-shard uploads".

## Export Pipeline

### Strategy selection

At the call site (in `exportUpload` or the worker loop in `phases/export.ts`),
check for shard records:

    shards = query('SELECT * FROM shards WHERE upload_root = ? ORDER BY shard_order', root_cid)
    if shards.length > 0 → call exportUploadViaShards()
    else → call existing exportUpload() (unchanged)

### exportUploadViaShards — new function

Lives as a new function alongside `exportUpload` in `core/pipeline.ts`
(or in a new `core/shard-pipeline.ts` if pipeline.ts is already too large).

1. Mark upload `downloading`.
2. Create an async generator that iterates shards in order:
   - Fetch each shard from `dag.w3s.link/ipfs/{shardCid}?format=raw`.
   - Parse the response as a CAR file, yield each block.
   - Some intermediate shards have no roots in their CAR headers — this
     is expected and handled naturally since we only use blocks from the
     shards, ignoring their CAR roots. The output CAR gets the upload's
     root CID set in its header.
   - Update `bytes_transferred` after each shard completes.
3. Pass the combined `AsyncIterable<Block>` to `backend.importCar(rootCid, blockStream)`.
   The backend receives a single block stream — same interface as today.
   Local backend writes a single `{rootCid}.car`. Kubo backend streams to
   `dag/import`.
4. Call `backend.verifyDag(rootCid)`.
   - Valid → mark `complete`.
   - Invalid → mark `error` (no repair in shard path for now).

No repair attempt in the shard path. Each shard is bounded (≤128MB) and
either succeeds or fails entirely with retries.

## Fetcher

New method `fetchShard(cidStr: string): Promise<Response>`:
- Endpoint: `GET {gateway}/ipfs/{cid}?format=raw`
  (`?format=raw` returns the raw blob content — which for data shards is
  a valid CAR file, not a single raw block as with `fetchBlock`)
- Uses `carDispatcher` (120s body timeout, 60s headers timeout) since
  shards can be up to 128MB.
- Respects shared `RateLimitGate`.
- 3 retries with exponential backoff on 429/5xx.
- Returns the HTTP `Response` (body is a ReadableStream of CAR bytes).
  The caller parses it as a CAR using `CarBlockIterator`.

Existing `fetchCar()` and `fetchBlock()` stay unchanged for the old path.

## What Doesn't Change

- **Repair machinery** — stays as-is for the old full-DAG path.
- **Block tracking / manifest** — not used by shard path.
- **Verify phase** — unchanged, calls `verifyDag()` on all complete uploads.
- **Dashboard** — reads from `uploads` table, works as before.
- **Kubo backend** — receives block stream via `importCar()`, unchanged.
- **CLI arguments** — no new flags. Shard path is automatic.
- **Auth** — same client, just also calls `blob.list()`.

## Resume Behavior

Pending/incomplete uploads from prior runs are picked up by the new shard
path if they have shard records. For the ~5-6 currently pending uploads,
the shard path re-downloads all shards from scratch (no partial shard
tracking needed).

Blob discovery runs on every invocation (before export), so even if a
previous run crashed mid-discovery, the next run will complete the blob
enumeration before exporting anything.

## Future Work

- Wire repair into shard path if needed (use index byte-range data for
  block-level recovery within a shard).
- Remove old full-DAG path once shard approach is validated across all spaces.
- `verifyDag` may be slow for the very large multi-shard uploads this
  feature targets — consider a lighter verification if this becomes a
  bottleneck.

# Shard Export via Indexing Service

Fetch shards directly from Storacha blob storage using location claims, bypassing the IPFS gateway entirely.

## Problem

The v3 shard export attempted to fetch shards via the IPFS gateway (`w3s.link/ipfs/{cid}?format=raw`). The gateway cannot resolve raw-codec blob CIDs and returns 504 on every request.

The filecoin-pin-migration PR (storacha/upload-service#694) shows the correct approach: use the indexing service to resolve location claims, then fetch directly from the R2/S3 URLs.

## Design

### Discovery

For each upload root:

1. Call `client.capability.upload.shard.list(root)` — returns shard CIDs (paginated)
2. Batch shard multihashes into one `indexer.queryClaims({ hashes, kind: 'standard' })` call
3. Extract `assert/location` claims — the `location[0]` URL points directly to the blob in R2
4. Store: `{ uploadRoot, shardCid, locationURL, size, order }`

Discovery runs during the existing enumeration phase, per-upload. No separate "discover shards" pass needed.

### Export path selection

In `exportUpload()`, before attempting the gateway CAR fetch:

1. Look up shards for this upload root
2. If shards exist with resolved location URLs → use shard path
3. Otherwise → fall back to existing gateway CAR path (v2 behavior)

### Shard fetch and import

For each shard (in order):

1. `fetch(locationURL)` — returns raw CAR bytes directly from R2
2. Parse with `CarBlockIterator` — stream blocks to backends (reusing existing fan-out)
3. Track blocks in manifest (same as v2 CAR path)

After all shards imported, run `verifyDag()` on each backend.

### Error handling

- If a shard fetch fails (HTTP error), retry with exponential backoff (same as v2)
- If location URL resolution fails for a shard, skip shard path and fall back to gateway
- Rate limiting: location URLs hit R2 directly, not the gateway — no shared rate gate needed
- Partial progress: manifest tracks blocks seen across shards, so interrupted runs resume

### New dependency

```
@storacha/indexing-service-client
```

### Schema changes

New table (or extend existing `shards` table from v3 branch):

```sql
CREATE TABLE IF NOT EXISTS shards (
  upload_root TEXT NOT NULL,
  shard_cid TEXT NOT NULL,
  location_url TEXT,
  shard_size INTEGER,
  shard_order INTEGER NOT NULL,
  space_did TEXT NOT NULL,
  PRIMARY KEY (upload_root, shard_cid)
);
```

### Changes to existing code

- `src/phases/discover.ts` — add `resolveShards()` function called during enumeration
- `src/core/pipeline.ts` — add shard path before gateway CAR fetch
- `src/core/fetcher.ts` — add `fetchFromURL(url)` method (no gateway prefix, no ?format=raw)
- `src/core/db.ts` — add `shards` table
- `src/core/shards.ts` — rewrite: simpler ShardStore using upload.shard.list + indexing service

### What stays the same

- Backend interface unchanged
- Multi-backend fan-out works the same (blocks stream to all backends)
- Queue, manifest, repair — all unchanged
- Dashboard, CLI args — unchanged (except new `--no-shards` flag to disable)

## Scope

- Shard discovery via upload.shard.list + indexing service
- Direct R2 fetch for shard CARs
- Fallback to gateway when shards unavailable
- No repair in shard path (bounded shard size makes full retries acceptable)

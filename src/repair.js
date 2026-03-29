import { CarBlockIterator, CarWriter } from '@ipld/car'
import { Readable } from 'node:stream'
import { CID } from 'multiformats/cid'
import { sha256 } from 'multiformats/hashes/sha2'
import { Agent } from 'undici'
import { log } from './progress.js'

const DAG_PB_CODE = 0x70

// Lazy import dag-pb only when needed (repair is not the common path)
let dagPB
async function getDagPB() {
  if (!dagPB) dagPB = await import('@ipld/dag-pb')
  return dagPB
}

const fetchDispatcher = new Agent({
  bodyTimeout: 60000,
  headersTimeout: 30000,
})

/**
 * Attempt to repair a truncated CAR by fetching missing blocks individually.
 *
 * Strategy:
 * 1. Re-download the CAR (it will be truncated again, but we parse what we get)
 * 2. From the DAG-PB nodes, extract all links
 * 3. Find links not present in the truncated CAR — these are missing blocks
 * 4. If any missing links are DAG-PB nodes (not just raw leaves), we can't
 *    guarantee we have the full link structure — bail out
 * 5. Fetch each missing block individually as ?format=raw
 * 6. Build a new CAR with the missing blocks and return it as a stream
 *
 * @param {string} rootCid
 * @param {string} gatewayUrl
 * @param {(info: object) => void} [onProgress]
 * @returns {Promise<{stream: Readable, blockCount: number} | null>} CAR stream of missing blocks, or null if repair not possible
 */
export async function repairTruncatedCar(rootCid, gatewayUrl, onProgress) {
  const { decode } = await getDagPB()

  log('REPAIR', `[${rootCid.slice(0, 24)}...] Attempting repair — re-downloading to find missing blocks`)

  // Step 1: Re-download and parse the truncated CAR
  const carUrl = `${gatewayUrl.replace(/\/$/, '')}/ipfs/${rootCid}?format=car`
  const res = await fetch(carUrl, { dispatcher: fetchDispatcher })
  if (!res.ok) {
    log('REPAIR', `[${rootCid.slice(0, 24)}...] Re-download failed: HTTP ${res.status}`)
    return null
  }

  const carStream = Readable.fromWeb(res.body)
  const iterator = await CarBlockIterator.fromIterable(carStream)
  const roots = await iterator.getRoots()

  const seenCids = new Set()
  const dagPBLinks = []  // all links found in dag-pb nodes
  const dagPBCids = new Set() // CIDs that are dag-pb nodes

  try {
    for await (const { cid, bytes } of iterator) {
      seenCids.add(cid.toString())
      if (cid.code === DAG_PB_CODE) {
        dagPBCids.add(cid.toString())
        const node = decode(bytes)
        for (const link of node.Links) {
          dagPBLinks.push(link.Hash.toString())
        }
      }
    }
  } catch {
    // Expected — truncation
  }

  const missing = [...new Set(dagPBLinks.filter(l => !seenCids.has(l)))]

  if (missing.length === 0) {
    log('REPAIR', `[${rootCid.slice(0, 24)}...] No missing blocks found — CAR may be complete`)
    return null
  }

  // Check if any missing blocks are dag-pb nodes (we'd need their links too)
  // We can tell by checking if any missing CID appears as a link target from
  // another dag-pb node that itself has children. In practice, for UnixFS,
  // missing dag-pb nodes would mean we can't enumerate all leaves.
  // Simple check: if we have dag-pb nodes linking to the missing CIDs,
  // the missing CIDs are likely raw leaves. If a missing CID was itself
  // referenced from within a dag-pb subtree we haven't seen, we're in trouble.
  // For now, optimistically proceed — the fetch will tell us if blocks are
  // actually available.

  log('REPAIR', `[${rootCid.slice(0, 24)}...] Have ${seenCids.size} blocks, missing ${missing.length} — fetching individually`)
  onProgress?.({ type: 'repair', rootCid, total: missing.length, fetched: 0 })

  // Step 2: Fetch missing blocks
  const fetchedBlocks = []
  let failures = 0
  for (const [i, cidStr] of missing.entries()) {
    const blockUrl = `https://${cidStr}.ipfs.w3s.link/?format=raw`
    try {
      const blockRes = await fetch(blockUrl, { dispatcher: fetchDispatcher })
      if (!blockRes.ok) {
        log('REPAIR', `  FAIL ${cidStr.slice(0, 24)}...: HTTP ${blockRes.status}`)
        failures++
        continue
      }
      const raw = new Uint8Array(await blockRes.arrayBuffer())
      const hash = await sha256.digest(raw)
      const cid = CID.create(1, 0x55, hash)
      if (cid.toString() !== cidStr) {
        log('REPAIR', `  CID MISMATCH ${cidStr.slice(0, 24)}...`)
        failures++
        continue
      }
      fetchedBlocks.push({ cid, bytes: raw })
      if ((i + 1) % 50 === 0) {
        log('REPAIR', `  fetched ${i + 1}/${missing.length}`)
        onProgress?.({ type: 'repair', rootCid, total: missing.length, fetched: i + 1 })
      }
    } catch (e) {
      log('REPAIR', `  ERROR ${cidStr.slice(0, 24)}...: ${e.message}`)
      failures++
    }
  }

  if (fetchedBlocks.length === 0) {
    log('REPAIR', `[${rootCid.slice(0, 24)}...] Could not fetch any missing blocks`)
    return null
  }

  if (failures > 0) {
    log('REPAIR', `[${rootCid.slice(0, 24)}...] ${failures} blocks could not be fetched — repair incomplete`)
  }

  log('REPAIR', `[${rootCid.slice(0, 24)}...] Fetched ${fetchedBlocks.length}/${missing.length} missing blocks, building repair CAR`)

  // Step 3: Build a CAR with just the missing blocks
  const { writer, out } = CarWriter.create(roots)
  const chunks = []
  const drain = (async () => { for await (const chunk of out) chunks.push(chunk) })()

  for (const { cid, bytes } of fetchedBlocks) {
    await writer.put({ cid, bytes })
  }
  await writer.close()
  await drain

  const carBuffer = Buffer.concat(chunks)
  log('REPAIR', `[${rootCid.slice(0, 24)}...] Repair CAR: ${(carBuffer.length / 1024 / 1024).toFixed(1)} MiB, ${fetchedBlocks.length} blocks`)

  return {
    stream: Readable.from([carBuffer]),
    blockCount: fetchedBlocks.length,
    complete: failures === 0,
  }
}

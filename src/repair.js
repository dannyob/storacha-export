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
  const dagPBLinks = []  // { cidStr, codec } for all links found in dag-pb nodes

  try {
    for await (const { cid, bytes } of iterator) {
      seenCids.add(cid.toString())
      if (cid.code === DAG_PB_CODE) {
        const node = decode(bytes)
        for (const link of node.Links) {
          dagPBLinks.push({ cidStr: link.Hash.toString(), codec: link.Hash.code })
        }
      }
    }
  } catch {
    // Expected — truncation
  }

  const missingAll = dagPBLinks.filter(l => !seenCids.has(l.cidStr))
  const missingUnique = [...new Map(missingAll.map(l => [l.cidStr, l])).values()]
  const missingDagPB = missingUnique.filter(l => l.codec === DAG_PB_CODE)

  if (missingUnique.length === 0) {
    log('REPAIR', `[${rootCid.slice(0, 24)}...] No missing blocks found — CAR may be complete`)
    return null
  }

  if (missingDagPB.length > 0) {
    log('REPAIR', `[${rootCid.slice(0, 24)}...] Cannot repair: ${missingDagPB.length} missing DAG-PB node(s) — tree structure incomplete`)
    log('REPAIR', `  Missing structure nodes: ${missingDagPB.map(l => l.cidStr.slice(0, 24) + '...').join(', ')}`)
    return null
  }

  const missing = missingUnique.map(l => l.cidStr)

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

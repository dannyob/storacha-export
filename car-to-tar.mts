#!/usr/bin/env npx tsx
/**
 * car-to-tar: Convert one or more CAR files into a TAR archive.
 *
 * Reads the UnixFS DAG rooted in the CAR(s) and emits a TAR with the
 * original file/directory tree. Best-effort: missing blocks cause the
 * affected file to be skipped with a warning, not a hard failure.
 *
 * Usage:
 *   car-to-tar [options] <car-file>...
 *
 *   -o, --out PATH    Output path (default: ./<root-cid>.tar)
 *   --stdout          Write tar to stdout (binary); logs go to stderr
 *   --root CID        Override root CID (escape hatch)
 *   -h, --help        Show help
 */
import fs from 'node:fs'
import { CarReader } from '@ipld/car'
import { exporter, type UnixFSEntry } from 'ipfs-unixfs-exporter'
import * as tar from 'tar-stream'
import { CID } from 'multiformats/cid'

export interface ConvertOptions {
  carPaths: string[]
  out: NodeJS.WritableStream
  root?: CID
  log?: (msg: string) => void
}

export interface ConvertResult {
  extracted: number
  extractedBytes: number
  skipped: number
  warnings: number
}

export async function convert(opts: ConvertOptions): Promise<ConvertResult> {
  const log = opts.log ?? ((m: string) => { process.stderr.write(m + '\n') })

  // Pool blocks across all CARs
  const blocks = new Map<string, Uint8Array>()
  const declaredRoots: CID[] = []
  for (const carPath of opts.carPaths) {
    const reader = await CarReader.fromIterable(fs.createReadStream(carPath) as any)
    for (const r of await reader.getRoots()) declaredRoots.push(r as unknown as CID)
    for await (const block of reader.blocks()) {
      blocks.set(block.cid.toString(), block.bytes)
    }
  }

  // Resolve root
  let rootCid: CID
  if (opts.root) {
    rootCid = opts.root
  } else {
    const unique = new Set(declaredRoots.map(c => c.toString()))
    if (unique.size === 0) throw new Error('no roots declared in any input CAR; pass --root')
    if (unique.size > 1) throw new Error(`input CARs declare disagreeing roots: ${[...unique].join(', ')} — pass --root to override`)
    rootCid = CID.parse([...unique][0])
  }

  // Minimal blockstore adapter — exporter expects get() to return an
  // (async)iterable of Uint8Array, not Promise<Uint8Array>.
  const blockstore = {
    async *get(cid: { toString(): string }) {
      const bytes = blocks.get(cid.toString())
      if (!bytes) throw new Error(`missing block: ${cid}`)
      yield bytes
    },
  } as any

  // Tar producer + pump
  const pack = tar.pack()
  const pumpDone = (async () => {
    for await (const chunk of pack) {
      await new Promise<void>((resolve, reject) => {
        opts.out.write(chunk as Uint8Array, err => err ? reject(err) : resolve())
      })
    }
  })()

  let extracted = 0
  let extractedBytes = 0
  let skipped = 0
  let warnings = 0

  async function emitFile(entry: UnixFSEntry & { type: 'file' | 'raw' }, name: string) {
    try {
      const chunks: Uint8Array[] = []
      for await (const chunk of entry.content()) chunks.push(chunk)
      const content = Buffer.concat(chunks)
      await new Promise<void>((resolve, reject) => {
        const s = pack.entry({ name, size: content.length, type: 'file' }, (err: any) => err ? reject(err) : resolve())
        s.end(content)
      })
      extracted++
      extractedBytes += content.length
    } catch (err: any) {
      log(`WARN: truncated ${name} (${entry.cid}): ${err.message}`)
      skipped++
      warnings++
    }
  }

  async function emitDir(name: string) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({ name: name + '/', type: 'directory' }, (err: any) => err ? reject(err) : resolve())
    })
    extracted++
  }

  // entries() yields stripped child stubs (cid + name only). Re-load each
  // via exporter() to get a full UnixFSEntry with content()/entries().
  async function loadFull(stub: { cid: any }): Promise<UnixFSEntry> {
    return await exporter(stub.cid, blockstore)
  }

  async function walk(entry: UnixFSEntry, prefix: string) {
    if (entry.type === 'directory') {
      if (prefix !== '') await emitDir(prefix)
      try {
        for await (const stub of (entry as any).entries()) {
          const childPath = prefix === '' ? stub.name : `${prefix}/${stub.name}`
          let child: UnixFSEntry
          try {
            child = await loadFull(stub)
          } catch (err: any) {
            log(`WARN: missing child ${childPath} (${stub.cid}): ${err.message}`)
            skipped++
            warnings++
            continue
          }
          await walk(child, childPath)
        }
      } catch (err: any) {
        log(`WARN: partial directory ${prefix} (${entry.cid}): ${err.message}`)
        warnings++
      }
    } else if (entry.type === 'file' || entry.type === 'raw') {
      await emitFile(entry as any, prefix)
    }
  }

  try {
    const root = await exporter(rootCid as any, blockstore)
    if (root.type === 'directory') {
      // strip the wrapper directory: emit children at the top level
      for await (const stub of (root as any).entries()) {
        let child: UnixFSEntry
        try {
          child = await loadFull(stub)
        } catch (err: any) {
          log(`WARN: missing child ${stub.name} (${stub.cid}): ${err.message}`)
          skipped++
          warnings++
          continue
        }
        await walk(child, stub.name)
      }
    } else if (root.type === 'file' || root.type === 'raw') {
      // single-file root: name it after the CID
      await emitFile(root as any, rootCid.toString())
    } else {
      log(`WARN: unsupported root type ${root.type}`)
      warnings++
    }
  } catch (err: any) {
    log(`WARN: walk aborted at root: ${err.message}`)
    warnings++
  }

  pack.finalize()
  await pumpDone

  return { extracted, extractedBytes, skipped, warnings }
}

/**
 * Read just the header of a CAR to recover its declared root(s),
 * without scanning all blocks.
 */
async function readCarRoots(carPath: string): Promise<CID[]> {
  const reader = await CarReader.fromIterable(fs.createReadStream(carPath) as any)
  const roots = await reader.getRoots()
  return roots as unknown as CID[]
}

// --- CLI ---

const HELP = `Usage: car-to-tar [options] <car-file>...

Extract the UnixFS files inside one or more CAR files into a TAR archive.

Options:
  -o, --out PATH     Output path (default: ./<root-cid>.tar)
  --stdout           Write tar to stdout (binary); logs go to stderr
  --root CID         Override root CID (escape hatch for missing/multiple roots)
  -h, --help         Show this help

Multiple CAR files are pooled into one block store, so passing every shard
of a sharded upload reconstructs the full DAG. Files whose blocks can't be
found are skipped with a warning; the resulting tar is still valid.
`

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    process.stderr.write(HELP)
    process.exit(argv.length === 0 ? 1 : 0)
  }

  let outPath: string | null = null
  let useStdout = false
  let rootOverride: CID | null = null
  const carPaths: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-o' || a === '--out') outPath = argv[++i]
    else if (a === '--stdout' || a === '-') useStdout = true
    else if (a === '--root') rootOverride = CID.parse(argv[++i])
    else if (a.startsWith('-')) {
      process.stderr.write(`unknown flag: ${a}\n`)
      process.exit(1)
    } else carPaths.push(a)
  }

  if (carPaths.length === 0) {
    process.stderr.write('error: no input CAR files\n')
    process.exit(1)
  }

  // Resolve root for default output naming (only if no --out and not --stdout)
  let resolvedRoot: CID
  if (rootOverride) {
    resolvedRoot = rootOverride
  } else {
    const seen = new Set<string>()
    for (const p of carPaths) for (const r of await readCarRoots(p)) seen.add(r.toString())
    if (seen.size === 0) {
      process.stderr.write('error: no roots declared in any input CAR; pass --root\n')
      process.exit(1)
    }
    if (seen.size > 1) {
      process.stderr.write(`error: input CARs declare disagreeing roots: ${[...seen].join(', ')} — pass --root to override\n`)
      process.exit(1)
    }
    resolvedRoot = CID.parse([...seen][0])
  }

  const out: NodeJS.WritableStream = useStdout
    ? process.stdout
    : fs.createWriteStream(outPath ?? `./${resolvedRoot.toString()}.tar`)

  const result = await convert({
    carPaths,
    out,
    root: resolvedRoot,
    log: m => process.stderr.write(m + '\n'),
  })

  // Close output if it's a file
  if (!useStdout) (out as fs.WriteStream).end()

  // Summary
  process.stderr.write(`\nExtracted: ${result.extracted} entries (${formatBytes(result.extractedBytes)})\n`)
  if (result.skipped) process.stderr.write(`Skipped:   ${result.skipped} files (missing blocks)\n`)
  if (result.warnings) process.stderr.write(`Warnings:  ${result.warnings}\n`)

  if (result.extracted === 0) process.exit(2)
  process.exit(0)
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  return `${(n / 1024 ** 3).toFixed(2)} GiB`
}

// Run main only when this file is executed directly (not when imported by tests).
const isMain = (() => {
  try {
    const argv1 = process.argv[1]
    return argv1 && (argv1.endsWith('car-to-tar.mts') || argv1.endsWith('car-to-tar'))
  } catch { return false }
})()

if (isMain) {
  main().catch(err => {
    process.stderr.write(`fatal: ${err?.message ?? err}\n`)
    process.exit(1)
  })
}


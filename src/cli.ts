import { Command } from 'commander'
import { checkbox, confirm, input, select } from '@inquirer/prompts'
import { detectCredentials, login } from './auth.js'
import { enumerateUploads, collectSpaceSizes } from './phases/discover.js'
import { runExport } from './phases/export.js'
import { runVerify } from './phases/verify.js'
import { createDatabase } from './core/db.js'
import { UploadQueue } from './core/queue.js'
import { BlockManifest } from './core/manifest.js'
import { createBackend } from './backends/registry.js'
import { startDashboard } from './dashboard/server.js'
import { generateDashboardHtml } from './dashboard/html.js'
import type { DashboardState } from './dashboard/html.js'
import { log } from './util/log.js'
import fs from 'node:fs'
import type { ExportBackend } from './backends/interface.js'

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
    .option('--backend <type...>', 'Backend(s): kubo')
    .option('--output <dir>', 'Output directory (local backend)')
    .option('--kubo-api <url>', 'Kubo API endpoint (URL or multiaddr)', 'http://127.0.0.1:5001')
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

  // --- Dashboard state (shared across all phases) ---
  let phase: DashboardState['phase'] = 'discovery'
  let statusMessage = 'Starting up...'
  const logLines: string[] = []
  const spaceSizes = new Map<string, number>()
  let queue: UploadQueue | undefined
  let htmlOutInterval: ReturnType<typeof setInterval> | undefined

  function addLogLine(msg: string) {
    logLines.push(msg)
    if (logLines.length > 50) logLines.shift()
  }

  function buildDashboardState(): DashboardState {
    const emptyStats = { total: 0, complete: 0, error: 0, pending: 0, downloading: 0, partial: 0, repairing: 0, total_bytes: 0 }
    return {
      phase,
      pid: process.pid,
      stats: queue ? queue.getStats() : emptyStats,
      bySpace: [],
      spaceSizes,
      activeJobs: [],
      recentDone: [],
      recentErrors: [],
      logLines: [...logLines],
      statusMessage,
    }
  }

  const onProgress = (info: { type: string; [key: string]: any }) => {
    addLogLine(`${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${JSON.stringify(info)}`)
  }

  // --- Start dashboard ASAP ---
  if (opts.serve) {
    const [host, portStr] = (typeof opts.serve === 'string' ? opts.serve : '127.0.0.1:9000').split(':')
    const port = portStr ? parseInt(portStr, 10) : 9000
    const { url } = await startDashboard({
      host,
      port,
      password: opts.servePassword,
      getHtml: () => generateDashboardHtml(buildDashboardState()),
    })
    log('INFO', `Dashboard: ${url}`)
  }

  if (opts.htmlOut) {
    htmlOutInterval = setInterval(() => {
      fs.writeFileSync(opts.htmlOut, generateDashboardHtml(buildDashboardState()))
    }, 5000)
  }

  // --- Auth ---
  statusMessage = 'Checking credentials...'
  log('INFO', 'Checking for Storacha credentials...')
  const creds = await detectCredentials()

  let client: any
  if (creds.hasCredentials) {
    log('INFO', `Found credentials for ${creds.accounts.join(', ')} with ${creds.spaces.length} spaces`)
    addLogLine(`Found credentials: ${creds.accounts.join(', ')} (${creds.spaces.length} spaces)`)
    statusMessage = `Authenticated as ${creds.accounts.join(', ')}`
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
    statusMessage = 'No credentials found — waiting for login'
    const email = await input({ message: 'Email to log in with:' })
    client = await login(email)
  }

  // --- Space selection ---
  const allSpaces: Array<{ did: string; name: string }> = client.spaces().map((s: any) => ({
    did: s.did(),
    name: s.name || '(unnamed)',
  }))

  let selectedSpaces: typeof allSpaces

  if (opts.space) {
    selectedSpaces = allSpaces.filter((s) =>
      opts.space.some((n: string) => s.name.toLowerCase() === n.toLowerCase())
    )
  } else if (opts.excludeSpace) {
    selectedSpaces = allSpaces.filter((s) =>
      !opts.excludeSpace.some((n: string) => s.name.toLowerCase() === n.toLowerCase())
    )
  } else if (needsWizard) {
    selectedSpaces = await checkbox({
      message: 'Select spaces to export (Space to toggle, Enter to confirm):',
      choices: allSpaces.map((s) => ({ name: s.name, value: s, checked: true })),
      required: true,
    })
  } else {
    selectedSpaces = allSpaces
  }

  const spaceList = selectedSpaces.map((s) => s.name).join(', ')
  console.log(`\nExporting ${selectedSpaces.length} space(s): ${spaceList}`)
  statusMessage = `Selected ${selectedSpaces.length} space(s): ${spaceList}`
  addLogLine(`Selected spaces: ${spaceList}`)

  // --- Backend selection ---
  let backends: ExportBackend[]
  if (opts.backend) {
    backends = opts.backend.map((name: string) =>
      createBackend(name, { apiUrl: opts.kuboApi, outputDir: opts.output, clusterApi: opts.clusterApi })
    )
  } else {
    const backendName = await select({
      message: 'Select a backend:',
      choices: [{ name: 'kubo (local IPFS node)', value: 'kubo' }],
    })
    backends = [createBackend(backendName, { apiUrl: 'http://127.0.0.1:5001' })]
  }

  // Init backends
  for (const backend of backends) {
    if (backend.init) {
      try {
        await backend.init()
        log('INFO', `Backend ${backend.name}: connected`)
        addLogLine(`Backend ${backend.name}: connected`)
      } catch (err: any) {
        log('ERROR', `Backend ${backend.name} init failed: ${err.message}`)
        process.exit(1)
      }
    }
  }

  // --- DB setup ---
  const dbPath = opts.db
  const dbExists = fs.existsSync(dbPath)

  if (dbExists && !opts.fresh) {
    if (needsWizard && process.stdout.isTTY) {
      const resume = await confirm({
        message: 'Found a previous export run. Resume it?',
        default: true,
      })
      if (!resume) fs.unlinkSync(dbPath)
    }
  }
  if (opts.fresh && dbExists) fs.unlinkSync(dbPath)

  const db = createDatabase(dbPath)
  queue = new UploadQueue(db)
  const manifest = new BlockManifest(db)

  if (dbExists && !opts.fresh) {
    const reset = queue.resetForRetry()
    if (reset > 0) log('INFO', `Reset ${reset} stuck/failed job(s) for retry`)
    const stats = queue.getStats()
    log('INFO', `Resuming: ${stats.complete} done, ${stats.pending} pending`)
    addLogLine(`Resuming: ${stats.complete} done, ${stats.pending} pending`)
  }

  // --- Collect sizes + enumerate ---
  statusMessage = 'Collecting space sizes...'
  addLogLine('Querying space sizes...')
  const sizes = await collectSpaceSizes(client, selectedSpaces, db)
  for (const [did, bytes] of sizes) {
    const space = selectedSpaces.find(s => s.did === did)
    if (space) {
      spaceSizes.set(space.name, bytes)
      addLogLine(`  ${space.name}: ${filesize(bytes)}`)
    }
  }

  // Enumerate and queue
  let enumCount = 0
  const batch: any[] = []
  statusMessage = 'Enumerating uploads...'
  for await (const upload of enumerateUploads(client, selectedSpaces)) {
    enumCount++
    if (enumCount % 100 === 0) {
      statusMessage = `Enumerating uploads... ${enumCount} found`
    }
    for (const be of backends) {
      batch.push({
        rootCid: upload.rootCid,
        spaceDid: upload.spaceDid,
        spaceName: upload.spaceName,
        backend: be.name,
      })
    }
    if (batch.length >= 500) { queue.addBatch(batch); batch.length = 0 }
  }
  if (batch.length > 0) queue.addBatch(batch)
  statusMessage = `Enumerated ${enumCount} uploads`
  addLogLine(`Enumeration complete: ${enumCount} uploads queued`)

  // --- Verify only? ---
  if (opts.verify) {
    phase = 'verify'
    statusMessage = 'Running verification...'
    const result = await runVerify({ queue, backends, onProgress })
    log('INFO', `Verified: ${result.verified}, Failed: ${result.failed}`)
    db.close()
    if (htmlOutInterval) clearInterval(htmlOutInterval)
    return
  }

  // --- Export phase ---
  phase = 'export'
  statusMessage = 'Exporting...'
  await runExport({
    queue,
    manifest,
    backends,
    gatewayUrl: opts.gateway,
    concurrency: opts.concurrency,
    spaceNames: selectedSpaces.map((s) => s.name),
    onProgress,
  })

  // --- Verify phase ---
  phase = 'verify'
  statusMessage = 'Running verification...'
  log('INFO', 'Running verification...')
  const verifyResult = await runVerify({ queue, backends, onProgress })
  log('INFO', `Verified: ${verifyResult.verified}, Failed: ${verifyResult.failed}`)

  // --- Cleanup ---
  statusMessage = 'Done'
  if (htmlOutInterval) clearInterval(htmlOutInterval)
  // Write final dashboard state
  if (opts.htmlOut) {
    fs.writeFileSync(opts.htmlOut, generateDashboardHtml(buildDashboardState()))
  }
  for (const backend of backends) {
    if (backend.close) await backend.close()
  }

  // --- Farewell ---
  const finalStats = queue.getStats()
  if (finalStats.error === 0 && finalStats.pending === 0) {
    console.log('\n🐔 Cock-a-doodle-done! All exports verified.\n')
  } else if (finalStats.error > 0) {
    console.log(`\n${finalStats.error} failed exports. Re-run to retry.\n`)
  }

  db.close()
}

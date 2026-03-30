import { Command } from 'commander'
import { checkbox, confirm, input, select } from '@inquirer/prompts'
import { detectCredentials, login } from './auth.js'
import { enumerateUploads } from './enumerator.js'
import { JobQueue } from './queue.js'
import { createBackend, listBackends } from './backends/index.js'
import { executeAll } from './executor.js'
import { createSpinner, createProgressBar, log, ts } from './progress.js'
import { printRooster } from './rooster.js'
import { startDashboard } from './server.js'
import { generateDashboardHtml } from './dashboard.js'
import fs from 'node:fs'
import path from 'node:path'

function filesize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GiB`
  return `${(bytes / 1024 / 1024 / 1024 / 1024).toFixed(1)} TiB`
}

export async function main(argv) {
  try {
    await _main(argv)
  } catch (err) {
    if (err.name === 'ExitPromptError' || err.message?.includes('force closed')) {
      // Ctrl+C during wizard — reset terminal and exit cleanly
      process.stdout.write('\x1B[?25h') // show cursor
      console.log('\nExiting.')
      process.exit(0)
    }
    throw err
  }
}

async function _main(argv) {
  const program = new Command()

  program
    .name('storacha-export')
    .description('Export Storacha space content to storage backends')
    .version('0.1.0')
    .option('--backend <type...>', 'Backend(s) to export to (local, kubo, cluster)')
    .option('--output <dir>', 'Output directory for local backend')
    .option('--kubo-api <url>', 'Kubo API endpoint (URL or multiaddr)')
    .option('--cluster-api <url>', 'IPFS Cluster API endpoint')
    .option('--space <name...>', 'Export only these spaces (repeatable)')
    .option('--exclude-space <name...>', 'Exclude these spaces (repeatable)')
    .option('--fresh', 'Start a new export, discarding previous progress')
    .option('--concurrency <n>', 'Concurrent transfers', (v) => parseInt(v, 10), 1)
    .option('--dry-run', 'Enumerate only, do not transfer')
    .option('--gateway <url>', 'Gateway URL', 'https://w3s.link')
    .option('--db <path>', 'SQLite database path', 'storacha-export.db')
    .option('--serve [host:port]', 'Start dashboard HTTP server (default: 127.0.0.1, random port)')
    .option('--serve-password <pass>', 'HTTP Basic Auth password for dashboard')
    .option('--html-out <path>', 'Write dashboard HTML to file periodically')

  program.parse(argv)
  const opts = program.opts()

  // Determine if we need the wizard
  const needsWizard = !opts.backend || opts.backend.length === 0

  // --- Auth ---
  const spinner = createSpinner('Checking for Storacha credentials...')
  const creds = await detectCredentials()

  let client
  if (creds.hasCredentials) {
    spinner.succeed(
      `Found credentials for ${creds.accounts.join(', ')} with access to ${creds.spaces.length} spaces`
    )
    if (needsWizard) {
      const useThem = await confirm({
        message: 'Use these credentials?',
        default: true,
      })
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
    spinner.fail('No Storacha credentials found')
    const email = await input({ message: 'Email to log in with:' })
    client = await login(email)
  }

  // --- Space selection ---
  let allSpaces = client.spaces().map(s => ({ did: s.did(), name: s.name || '(unnamed)' }))
  let selectedSpaces

  if (opts.space) {
    // CLI space filter
    selectedSpaces = allSpaces.filter(s =>
      opts.space.some(name => s.name.toLowerCase() === name.toLowerCase())
    )
    if (selectedSpaces.length === 0) {
      console.error(`No spaces matched: ${opts.space.join(', ')}`)
      console.error(`Available: ${allSpaces.map(s => s.name).join(', ')}`)
      process.exit(1)
    }
  } else if (opts.excludeSpace) {
    selectedSpaces = allSpaces.filter(s =>
      !opts.excludeSpace.some(name => s.name.toLowerCase() === name.toLowerCase())
    )
  } else if (needsWizard) {
    // Interactive space selection
    const choices = allSpaces.map(s => ({
      name: s.name,
      value: s,
      checked: true,
    }))
    selectedSpaces = await checkbox({
      message: 'Select spaces to export:',
      choices,
    })
    if (selectedSpaces.length === 0) {
      console.log('No spaces selected. Exiting.')
      process.exit(0)
    }
  } else {
    selectedSpaces = allSpaces
  }

  console.log(`\nExporting ${selectedSpaces.length} space(s): ${selectedSpaces.map(s => s.name).join(', ')}`)

  // --- Backend selection ---
  let backends = []

  if (needsWizard) {
    const backendChoices = [
      { name: 'Local CAR files', value: 'local' },
      { name: 'Kubo (IPFS node)', value: 'kubo' },
      { name: 'IPFS Cluster', value: 'cluster' },
    ]
    const selectedBackends = await checkbox({
      message: 'Select export backends (Space to toggle, Enter to confirm):',
      choices: backendChoices,
      required: true,
    })
    for (const name of selectedBackends) {
      if (name === 'local') {
        const dir = await input({
          message: 'Output directory for CAR files:',
          default: './storacha-cars',
        })
        backends.push(createBackend('local', { outputDir: dir }))
      } else if (name === 'kubo') {
        const api = await input({
          message: 'Kubo API endpoint:',
          default: '/ip4/127.0.0.1/tcp/5001',
        })
        backends.push(createBackend('kubo', { apiUrl: api }))
      } else if (name === 'cluster') {
        const api = await input({
          message: 'IPFS Cluster API endpoint:',
          default: 'http://127.0.0.1:9094',
        })
        backends.push(createBackend('cluster', { apiUrl: api }))
      }
    }
  } else {
    for (const name of opts.backend) {
      if (name === 'local') {
        if (!opts.output) {
          console.error('--output required for local backend')
          process.exit(1)
        }
        backends.push(createBackend('local', { outputDir: opts.output }))
      } else if (name === 'kubo') {
        if (!opts.kuboApi) {
          console.error('--kubo-api required for kubo backend')
          process.exit(1)
        }
        backends.push(createBackend('kubo', { apiUrl: opts.kuboApi }))
      } else if (name === 'cluster') {
        if (!opts.clusterApi) {
          console.error('--cluster-api required for cluster backend')
          process.exit(1)
        }
        backends.push(createBackend('cluster', { apiUrl: opts.clusterApi }))
      }
    }
  }

  if (backends.length === 0) {
    console.error('No backends selected. Exiting.')
    process.exit(1)
  }

  // --- Init backends ---
  for (const be of backends) {
    if (be.init) await be.init()
  }

  // --- Open/create job queue ---
  const dbPath = opts.db
  const dbExists = fs.existsSync(dbPath)
  let continuing = false

  if (dbExists && !opts.fresh) {
    if (needsWizard) {
      continuing = await confirm({
        message: 'Found a previous export run. Resume it? (No = re-scan everything; already-exported data is not affected)',
        default: true,
      })
    } else {
      continuing = true
    }
    if (!continuing) {
      fs.unlinkSync(dbPath)
    }
  }

  if (opts.fresh && dbExists) {
    fs.unlinkSync(dbPath)
  }

  const queue = new JobQueue(dbPath)

  if (continuing) {
    const resetStuck = queue.resetInProgress()
    const resetErrors = queue.resetErrors()
    if (resetStuck.changes > 0 || resetErrors.changes > 0) {
      console.log(`Reset ${resetStuck.changes} stuck job(s) and ${resetErrors.changes} failed job(s) for retry.`)
    }
    const prev = queue.getStats()
    console.log(`Resuming: ${prev.done} done, ${prev.pending} pending from previous run.`)
  }

  // --- Collect space sizes and sort smallest first ---
  // Check if we already have sizes from a previous run
  const existingSizes = new Map()
  for (const space of selectedSpaces) {
    const s = queue.getSpace(space.did)
    if (s?.total_bytes > 0) existingSizes.set(space.did, s.total_bytes)
  }

  if (existingSizes.size === selectedSpaces.length) {
    // All sizes cached — skip the slow usage report API
    for (const space of selectedSpaces) {
      space.totalBytes = existingSizes.get(space.did)
    }
    selectedSpaces.sort((a, b) => (a.totalBytes || 0) - (b.totalBytes || 0))
    console.log(`Using cached space sizes — smallest first: ${selectedSpaces.map(s => `${s.name} (${filesize(s.totalBytes || 0)})`).join(', ')}`)
  } else {
    const sizeSpinner = createSpinner('Collecting space sizes from Storacha...')
    try {
      const now = new Date()
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
      const period = { from, to: now }
      const spaceSizes = new Map()

      console.log('Querying usage reports for each space (this can be slow)...')
      for (const account of Object.values(client.accounts())) {
        const subs = await client.capability.subscription.list(account.did())
        for (const { consumers } of subs.results) {
          for (const spaceDid of consumers) {
            const space = selectedSpaces.find(s => s.did === spaceDid)
            if (!space) continue // skip spaces not in selection
            const spaceName = space.name
            console.log(`  Querying ${spaceName}...`)
            try {
              const result = await client.capability.usage.report(spaceDid, period)
              for (const [, report] of Object.entries(result)) {
                const prev = spaceSizes.get(spaceDid) || 0
                spaceSizes.set(spaceDid, prev + (report?.size?.final || 0))
              }
              console.log(`  ${spaceName}: ${filesize(spaceSizes.get(spaceDid) || 0)}`)
            } catch { console.log(`  ${spaceName}: skipped (no access)`) }
          }
        }
      }

      for (const space of selectedSpaces) {
        space.totalBytes = spaceSizes.get(space.did) || 0
        queue.upsertSpace({ did: space.did, name: space.name, totalUploads: 0, totalBytes: space.totalBytes })
      }
      selectedSpaces.sort((a, b) => (a.totalBytes || 0) - (b.totalBytes || 0))
      sizeSpinner.succeed(`Collected sizes — smallest first: ${selectedSpaces.map(s => `${s.name} (${filesize(s.totalBytes || 0)})`).join(', ')}`)
    } catch (e) {
      sizeSpinner.succeed('Could not collect sizes — using default order')
    }
  }

  // --- Enumerate ---
  const enumSpinner = createSpinner('Enumerating uploads...')
  let enumCount = 0
  let jobBatch = []

  for await (const upload of enumerateUploads(client, selectedSpaces, {
    onProgress: (msg) => { enumSpinner.text = msg },
  })) {
    // When continuing, check if backends already have this content
    // (handles case where DB was lost but content was already exported)
    if (continuing) {
      let alreadyDone = true
      for (const be of backends) {
        if (!(await be.hasContent(upload.rootCid))) {
          alreadyDone = false
          break
        }
      }
      if (alreadyDone) continue
    }

    for (const be of backends) {
      jobBatch.push({
        rootCid: upload.rootCid,
        spaceDid: upload.spaceDid,
        spaceName: upload.spaceName,
        backend: be.name,
      })
    }
    if (jobBatch.length >= 500) {
      queue.addJobsBatch(jobBatch)
      jobBatch = []
    }
    enumCount++
  }

  if (jobBatch.length > 0) {
    queue.addJobsBatch(jobBatch)
  }
  enumSpinner.succeed(`Enumerated ${enumCount} uploads to export`)

  if (opts.dryRun) {
    const stats = queue.getStats()
    console.log(`\nDry run complete:`)
    console.log(`  Total jobs: ${stats.total}`)
    console.log(`  Spaces: ${selectedSpaces.map(s => s.name).join(', ')}`)
    console.log(`  Backends: ${backends.map(b => b.name).join(', ')}`)
    queue.close()
    process.exit(0)
  }

  // --- Dashboard setup ---
  const selectedSpaceNames = new Set(selectedSpaces.map(s => s.name))
  const spaceNamesList = selectedSpaces.map(s => s.name)
  const spaceSizesMap = Object.fromEntries(selectedSpaces.map(s => [s.name, s.totalBytes || 0]))

  // Log ring buffer for dashboard
  const logBuffer = []
  const MAX_LOG_LINES = 50
  function addLogLine(level, msg) {
    const line = `${ts()} [${process.pid}] ${level} ${msg}`
    logBuffer.push(line)
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift()
  }

  function collectDashboardState() {
    const stats = queue.getStats()
    const bySpace = queue.getStatsBySpace(spaceNamesList)
    // Adjust stats to only count selected spaces
    const filteredStats = {
      total: bySpace.reduce((s, r) => s + r.total, 0),
      done: bySpace.reduce((s, r) => s + r.done, 0),
      error: bySpace.reduce((s, r) => s + r.errors, 0),
      pending: bySpace.reduce((s, r) => s + r.pending, 0),
    }
    const logLines = logBuffer
      .map(l => l.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'))
      .map(l => {
        if (l.includes('ERROR')) return `<span class="log-error">${l}</span>`
        if (l.includes('RETRY')) return `<span class="log-warn">${l}</span>`
        if (l.includes('REPAIR')) return `<span class="log-repair">${l}</span>`
        if (l.includes('DONE')) return `<span class="log-done">${l}</span>`
        return l
      })
      .join('\n')
    return {
      stats: filteredStats,
      bySpace,
      spaceSizes: spaceSizesMap,
      activeJobs: queue.getActiveJobs(),
      recentDone: queue.getRecentDone(),
      recentErrors: queue.getRecentErrors(),
      logLines,
      pid: process.pid,
    }
  }

  // Start dashboard server if requested
  if (opts.serve !== undefined) {
    const serveArg = typeof opts.serve === 'string' ? opts.serve : '127.0.0.1:0'
    const lastColon = serveArg.lastIndexOf(':')
    const host = lastColon > 0 ? serveArg.slice(0, lastColon) : '127.0.0.1'
    const port = lastColon > 0 ? parseInt(serveArg.slice(lastColon + 1), 10) : 0
    const { url } = await startDashboard({
      host, port,
      password: opts.servePassword,
      getHtml: () => generateDashboardHtml(collectDashboardState()),
    })
    console.log(`Dashboard: ${url}`)
  }

  // Periodic HTML file output
  let htmlOutInterval
  if (opts.htmlOut) {
    htmlOutInterval = setInterval(() => {
      try {
        fs.writeFileSync(opts.htmlOut, generateDashboardHtml(collectDashboardState()))
      } catch {}
    }, 5000)
  }

  // --- Execute ---
  const stats = queue.getStats()
  console.log(`\nJob queue: ${stats.total} total, ${stats.done} done, ${stats.error} errors, ${stats.pending} pending`)
  const selectedPending = queue.getPendingCountForSpaces(spaceNamesList)
  console.log(`Selected spaces: ${selectedPending} pending`)
  const bar = createProgressBar(selectedPending)
  let completed = 0

  await executeAll(queue, backends, {
    concurrency: opts.concurrency,
    gatewayUrl: opts.gateway,
    spaceFilter: (job) => selectedSpaceNames.has(job.space_name),
    onProgress: (info) => {
      if (info.type === 'done') {
        completed++
        const cidShort = info.rootCid.slice(0, 24) + '...'
        const size = info.bytes ? filesize(info.bytes) : ''
        bar.increment({
          cid: `[${info.spaceName}] ${cidShort}`,
          rate: size,
        })
        addLogLine('DONE', `[${info.spaceName}] ${cidShort} ${size}`)
      } else if (info.type === 'downloading') {
        log('DOWNLOADING', `[${info.spaceName}] ${info.rootCid.slice(0, 24)}... ${filesize(info.bytes)} so far`)
        addLogLine('DOWNLOADING', `[${info.spaceName}] ${info.rootCid.slice(0, 24)}... ${filesize(info.bytes)} so far`)
      } else if (info.type === 'error') {
        log('ERROR', `[${info.spaceName}] ${info.rootCid}: ${info.error}`)
        addLogLine('ERROR', `[${info.spaceName}] ${info.rootCid}: ${info.error}`)
      } else if (info.type === 'retry') {
        log('RETRY', `[${info.spaceName}] ${info.rootCid} attempt ${info.attempt}, waiting ${info.delay}ms: ${info.error}`)
        addLogLine('RETRY', `[${info.spaceName}] ${info.rootCid} attempt ${info.attempt}: ${info.error}`)
      } else if (info.type === 'repair') {
        addLogLine('REPAIR', `[${info.rootCid?.slice(0, 24)}...] fetched ${info.fetched}/${info.total} blocks`)
      } else if (info.type === 'complete') {
        bar.stop()
      }
    },
  })

  bar.stop()
  if (htmlOutInterval) clearInterval(htmlOutInterval)

  // --- Summary ---
  const finalStats = queue.getStats()
  console.log(`\nExport complete:`)
  console.log(`  Done:    ${finalStats.done}`)
  console.log(`  Errors:  ${finalStats.error}`)
  console.log(`  Pending: ${finalStats.pending}`)

  if (finalStats.error === 0 && finalStats.pending === 0) {
    printRooster({
      total: finalStats.done,
      spaces: selectedSpaces.length,
      bytes: filesize(queue.getTotalBytesTransferred()),
      backends: backends.map(b => b.name).join(', '),
    })
  } else if (finalStats.error > 0) {
    const errors = queue.getErrors()
    console.log(`\nFailed exports:`)
    for (const e of errors) {
      console.log(`  ${e.space_name} ${e.root_cid} → ${e.backend}: ${e.error_msg}`)
    }
    console.log(`\nRe-run to retry failed exports.`)
  }

  // --- Cleanup ---
  // Final dashboard write
  if (opts.htmlOut) {
    try { fs.writeFileSync(opts.htmlOut, generateDashboardHtml(collectDashboardState())) } catch {}
  }
  for (const be of backends) {
    if (be.close) await be.close()
  }
  queue.close()
}

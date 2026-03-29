import { Command } from 'commander'
import { checkbox, confirm, input, select } from '@inquirer/prompts'
import { detectCredentials, login } from './auth.js'
import { enumerateUploads } from './enumerator.js'
import { JobQueue } from './queue.js'
import { createBackend, listBackends } from './backends/index.js'
import { executeAll } from './executor.js'
import { createSpinner, createProgressBar } from './progress.js'
import { printRooster } from './rooster.js'
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
    .option('--continue', 'Resume a previous export')
    .option('--concurrency <n>', 'Concurrent transfers', parseInt, 1)
    .option('--dry-run', 'Enumerate only, do not transfer')
    .option('--gateway <url>', 'Gateway URL', 'https://w3s.link')
    .option('--db <path>', 'SQLite database path', 'storacha-export.db')
    .option('--log-format <format>', 'Log format: text or json')

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
  let queue

  if (opts.continue && !fs.existsSync(dbPath)) {
    console.log('No previous database found. Will check backends for existing content.')
  }
  queue = new JobQueue(dbPath)

  // Reset any jobs stuck in_progress from a crashed previous run
  if (opts.continue) {
    const reset = queue.resetInProgress()
    if (reset.changes > 0) {
      console.log(`Reset ${reset.changes} stuck in-progress job(s) from previous run.`)
    }
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
            const spaceName = selectedSpaces.find(s => s.did === spaceDid)?.name || spaceDid.slice(0, 20)
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

  for await (const upload of enumerateUploads(client, selectedSpaces, {
    onProgress: (msg) => { enumSpinner.text = msg },
  })) {
    // For --continue without DB, check backends before queuing
    if (opts.continue) {
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
      queue.addJob({
        rootCid: upload.rootCid,
        spaceDid: upload.spaceDid,
        spaceName: upload.spaceName,
        backend: be.name,
      })
    }
    enumCount++
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

  // --- Execute ---
  const stats = queue.getStats()
  console.log(`\nJob queue: ${stats.total} total, ${stats.done} done, ${stats.error} errors, ${stats.pending} pending`)
  const bar = createProgressBar(stats.pending)
  let completed = 0

  await executeAll(queue, backends, {
    concurrency: opts.concurrency,
    gatewayUrl: opts.gateway,
    onProgress: (info) => {
      if (info.type === 'done') {
        completed++
        bar.increment({
          cid: info.rootCid.slice(0, 20) + '...',
          rate: info.bytes ? filesize(info.bytes) : '',
        })
      } else if (info.type === 'error') {
        console.error(`\n  ERROR ${info.rootCid}: ${info.error}`)
      } else if (info.type === 'complete') {
        bar.stop()
      }
    },
  })

  bar.stop()

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
      bytes: filesize(
        queue.db.prepare('SELECT SUM(bytes_transferred) as total FROM jobs WHERE status = ?')
          .get('done')?.total || 0
      ),
      backends: backends.map(b => b.name).join(', '),
    })
  } else if (finalStats.error > 0) {
    const errors = queue.db.prepare(
      'SELECT root_cid, space_name, backend, error_msg FROM jobs WHERE status = ?'
    ).all('error')
    console.log(`\nFailed exports:`)
    for (const e of errors) {
      console.log(`  ${e.space_name} ${e.root_cid} → ${e.backend}: ${e.error_msg}`)
    }
    console.log(`\nRe-run with --continue to retry failed exports.`)
  }

  // --- Cleanup ---
  for (const be of backends) {
    if (be.close) await be.close()
  }
  queue.close()
}

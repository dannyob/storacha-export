import { Command } from 'commander'
import { log } from './util/log.js'

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
    .option('--backend <type...>', 'Backend(s): local, kubo, cluster')
    .option('--output <dir>', 'Output directory (local backend)')
    .option('--kubo-api <url>', 'Kubo API endpoint (URL or multiaddr)')
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

  // If --help or --version was processed, commander exits — we never get here
  // Full execution logic will be wired in after all sub-modules are ready (Task 7)
  const opts = program.opts()

  if (!opts.backend) {
    console.log('No --backend specified. Run with --help for usage.')
    process.exit(1)
  }

  log('INFO', 'storacha-export v2 — not yet wired')
}

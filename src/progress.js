import ora from 'ora'
import cliProgress from 'cli-progress'

const isTTY = process.stdout.isTTY
const pid = process.pid

function ts() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

function log(level, msg) {
  console.log(`${ts()} [${pid}] ${level} ${msg}`)
}

export function createSpinner(text) {
  if (isTTY) {
    return ora(text).start()
  }
  return {
    text,
    start() { log('INFO', text); return this },
    succeed(msg) { log('INFO', `✓ ${msg || this.text}`) },
    fail(msg) { log('ERROR', `✗ ${msg || this.text}`) },
    stop() {},
    set text(t) { log('INFO', t) },
    get text() { return text },
  }
}

export function createProgressBar(total) {
  if (isTTY) {
    const bar = new cliProgress.SingleBar({
      format: '{bar} {percentage}% | {value}/{total} | {cid} | {rate}',
      barCompleteChar: '█',
      barIncompleteChar: '░',
      hideCursor: true,
    })
    bar.start(total, 0, { cid: 'starting...', rate: '' })
    return {
      update(value, payload) { bar.update(value, payload) },
      increment(payload) { bar.increment(1, payload) },
      stop() { bar.stop() },
    }
  }

  // Non-TTY: log every item with timestamp and PID
  let current = 0
  return {
    update(value, payload) {
      current = value
      log('PROGRESS', `[${current}/${total}] ${payload?.cid || ''} ${payload?.rate || ''}`.trim())
    },
    increment(payload) {
      current++
      log('DONE', `[${current}/${total}] ${payload?.cid || ''} ${payload?.rate || ''}`.trim())
    },
    stop() {
      log('INFO', `Completed: ${current}/${total}`)
    },
  }
}

export { log, ts }

import ora from 'ora'
import cliProgress from 'cli-progress'

const isTTY = process.stdout.isTTY

export function createSpinner(text) {
  if (isTTY) {
    return ora(text).start()
  }
  // Non-TTY: just log
  return {
    text,
    start() { console.log(text); return this },
    succeed(msg) { console.log(`✓ ${msg || this.text}`) },
    fail(msg) { console.log(`✗ ${msg || this.text}`) },
    stop() {},
    set text(t) { /* no-op for non-TTY */ },
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

  // Non-TTY: periodic log lines
  let current = 0
  return {
    update(value, payload) {
      current = value
      console.log(`[${current}/${total}] ${payload?.cid || ''}`)
    },
    increment(payload) {
      current++
      if (current % 10 === 0 || current === total) {
        console.log(`[${current}/${total}] ${payload?.cid || ''}`)
      }
    },
    stop() {
      console.log(`Completed: ${current}/${total}`)
    },
  }
}

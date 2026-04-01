const pid = process.pid

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

export type LogLevel = 'INFO' | 'DONE' | 'ERROR' | 'RETRY' | 'REPAIR' | 'DOWNLOADING' | 'VERIFY'

type LogListener = (line: string) => void
let listener: LogListener | undefined

export function onLog(fn: LogListener): void {
  listener = fn
}

export function log(level: LogLevel, msg: string): void {
  const line = `${ts()} [${pid}] ${level} ${msg}`
  console.log(line)
  listener?.(line)
}

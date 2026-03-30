const pid = process.pid

function ts(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19)
}

export type LogLevel = 'INFO' | 'DONE' | 'ERROR' | 'RETRY' | 'REPAIR' | 'DOWNLOADING' | 'VERIFY'

export function log(level: LogLevel, msg: string): void {
  console.log(`${ts()} [${pid}] ${level} ${msg}`)
}

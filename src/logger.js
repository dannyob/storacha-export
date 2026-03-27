import pino from 'pino'

export function createLogger(options = {}) {
  const { logFormat, level } = options

  if (logFormat === 'json' || !process.stdout.isTTY) {
    return pino({
      level: level || process.env.LOG_LEVEL || 'info',
    })
  }

  // Pretty output for TTY — pino will handle this
  return pino({
    level: level || process.env.LOG_LEVEL || 'info',
    transport: {
      target: 'pino-pretty',
      options: { colorize: true },
    },
  })
}

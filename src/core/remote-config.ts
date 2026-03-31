import { log } from '../util/log.js'

export interface RemoteConfig {
  throttleMs?: number
  batchSize?: number
  concurrency?: number
  pause?: boolean
  message?: string
  checkIntervalMs?: number
  gateway?: string
}

const DEFAULT_URL = 'https://storacha.network/export.json'
const DEFAULT_CHECK_INTERVAL = 300000 // 5 minutes

let currentConfig: RemoteConfig = {}
let checkInterval: ReturnType<typeof setTimeout> | undefined
let configUrl = DEFAULT_URL

export function getRemoteConfig(): RemoteConfig {
  return currentConfig
}

async function fetchConfig(): Promise<RemoteConfig> {
  try {
    const res = await fetch(configUrl)
    if (!res.ok) return {}
    const config = await res.json() as RemoteConfig
    return config
  } catch {
    return {}
  }
}

export async function startRemoteConfig(url?: string): Promise<RemoteConfig> {
  configUrl = url || DEFAULT_URL

  currentConfig = await fetchConfig()

  if (currentConfig.message) {
    log('INFO', `Remote: ${currentConfig.message}`)
  }

  const baseInterval = currentConfig.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL
  // Jitter ±20% to avoid thundering herd
  const jitter = () => baseInterval + Math.round((Math.random() - 0.5) * baseInterval * 0.4)
  log('INFO', `Remote config: ${configUrl} (checking every ~${Math.round(baseInterval / 1000)}s)`)

  const scheduleNext = () => {
    checkInterval = setTimeout(async () => {
      const prev = currentConfig
      currentConfig = await fetchConfig()

      if (currentConfig.message && currentConfig.message !== prev.message) {
        log('INFO', `Remote: ${currentConfig.message}`)
      }
      if (currentConfig.pause && !prev.pause) {
        log('INFO', 'Remote: pausing exports')
      }
      if (!currentConfig.pause && prev.pause) {
        log('INFO', 'Remote: resuming exports')
      }
      scheduleNext()
    }, jitter())
  }
  scheduleNext()

  return currentConfig
}

export function stopRemoteConfig(): void {
  if (checkInterval) clearTimeout(checkInterval)
}

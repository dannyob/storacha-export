import { KuboBackend } from './kubo.js'
import { LocalBackend } from './local.js'
import { ClusterBackend } from './cluster.js'
import type { ExportBackend } from './interface.js'

export function createBackend(name: string, config: Record<string, any>): ExportBackend {
  switch (name) {
    case 'kubo':
      return new KuboBackend({ apiUrl: config.apiUrl || 'http://127.0.0.1:5001' })
    case 'local':
      return new LocalBackend({ outputDir: config.outputDir || './export' })
    case 'cluster':
      return new ClusterBackend({ apiUrl: config.apiUrl || 'http://127.0.0.1:9094' })
    default:
      throw new Error(`Unknown backend: ${name}. Available: kubo, local, cluster`)
  }
}

export function listBackends(): string[] {
  return ['kubo', 'local', 'cluster']
}

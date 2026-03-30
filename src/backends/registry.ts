import { KuboBackend } from './kubo.js'
import type { ExportBackend } from './interface.js'

export function createBackend(name: string, config: Record<string, any>): ExportBackend {
  switch (name) {
    case 'kubo':
      return new KuboBackend({ apiUrl: config.apiUrl || 'http://127.0.0.1:5001' })
    default:
      throw new Error(`Unknown backend: ${name}. Available backends: kubo`)
  }
}

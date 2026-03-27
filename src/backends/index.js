/**
 * @typedef {Object} ExportBackend
 * @property {string} name
 * @property {(rootCid: string) => Promise<boolean>} hasContent
 * @property {(rootCid: string, stream: import('node:stream').Readable) => Promise<void>} importCar
 * @property {() => Promise<void>} [init]
 * @property {() => Promise<void>} [close]
 */

import { LocalBackend } from './local.js'

const BACKENDS = {
  local: LocalBackend,
}

/**
 * @param {string} name
 * @param {object} config
 * @returns {ExportBackend}
 */
export function createBackend(name, config) {
  const Backend = BACKENDS[name]
  if (!Backend) {
    throw new Error(`Unknown backend: ${name}. Available: ${Object.keys(BACKENDS).join(', ')}`)
  }
  return new Backend(config)
}

export function listBackends() {
  return Object.keys(BACKENDS)
}

import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  plugins: [
    {
      name: 'prefer-ts',
      enforce: 'pre',
      resolveId(source, importer) {
        // When importing a .js file from src/ or test/, prefer the .ts version if it exists
        if (!importer || !source.endsWith('.js')) return null
        const resolved = path.resolve(path.dirname(importer), source)
        if (!resolved.startsWith(root)) return null
        const tsPath = resolved.replace(/\.js$/, '.ts')
        try {
          const fs = require('node:fs')
          if (fs.existsSync(tsPath)) return tsPath
        } catch {}
        return null
      },
    },
  ],
  test: {
    globals: true,
    testTimeout: 30000,
  },
})

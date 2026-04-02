import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const ROOT = resolve(new URL('.', import.meta.url).pathname, '../')

describe('e2e: storacha-export', () => {
  it('shows help', () => {
    const out = execFileSync('npx', ['tsx', resolve(ROOT, 'src/index.ts'), '--help'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    expect(out).toContain('storacha-export')
    expect(out).toContain('--backend')
    expect(out).toContain('--space')
    expect(out).toContain('--exclude-space')
    expect(out).toContain('--fresh')
    expect(out).toContain('--verify')
    expect(out).toContain('--serve')
    expect(out).toContain('--concurrency')
  })

  it('shows version', () => {
    const out = execFileSync('npx', ['tsx', resolve(ROOT, 'src/index.ts'), '--version'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    expect(out.trim()).toBe('3.0.0')
  })
})

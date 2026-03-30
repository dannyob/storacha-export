import { describe, it, expect, afterEach } from 'vitest'
import { startDashboard } from '../../src/dashboard/server.js'
import type http from 'node:http'

describe('dashboard server', () => {
  let server: http.Server | null = null

  afterEach(async () => {
    if (server) await new Promise<void>(r => server!.close(() => r()))
    server = null
  })

  it('serves HTML on random port', async () => {
    const result = await startDashboard({
      host: '127.0.0.1',
      port: 0,
      getHtml: () => '<html><body>test</body></html>',
    })
    server = result.server

    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const res = await fetch(result.url)
    const text = await res.text()
    expect(text).toContain('test')
  })

  it('enforces basic auth when password set', async () => {
    const result = await startDashboard({
      host: '127.0.0.1',
      port: 0,
      password: 'secret',
      getHtml: () => '<html>protected</html>',
    })
    server = result.server

    const noAuth = await fetch(result.url)
    expect(noAuth.status).toBe(401)

    const withAuth = await fetch(result.url, {
      headers: { Authorization: 'Basic ' + Buffer.from(':secret').toString('base64') },
    })
    expect(withAuth.status).toBe(200)
  })
})

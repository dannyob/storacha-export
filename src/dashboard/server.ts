import http from 'node:http'

export interface DashboardOptions {
  host?: string
  port?: number
  password?: string
  getHtml: () => string
}

export async function startDashboard(options: DashboardOptions): Promise<{ server: http.Server; url: string }> {
  const { host = '127.0.0.1', port = 0, password, getHtml } = options

  const server = http.createServer((req, res) => {
    if (password) {
      const auth = req.headers.authorization
      const expected = 'Basic ' + Buffer.from(':' + password).toString('base64')
      if (auth !== expected) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="storacha-export"' })
        res.end('Unauthorized')
        return
      }
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(getHtml())
  })

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address() as { address: string; port: number }
      resolve({ server, url: `http://${addr.address}:${addr.port}` })
    })
  })
}

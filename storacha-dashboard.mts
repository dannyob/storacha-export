#!/usr/bin/env npx tsx
/**
 * Generates a static HTML dashboard from the storacha-download DB.
 * Writes to a file every 20 seconds for serving via caddy/nginx.
 *
 * Usage: npx tsx storacha-dashboard.mts --db ~/storacha-download.db --out /store/fastphils/www/storacha-export.html
 */
import Database from 'better-sqlite3'
import fs from 'node:fs'

const args = process.argv.slice(2)
function arg(name: string, def: string): string {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : def
}
const DB_PATH = arg('db', './storacha-download.db')
const OUT_PATH = arg('out', '/store/fastphils/www/storacha-export.html')
const LOG_PATH = arg('log', '')

function render(db: Database.Database): string {
  const stats = db.prepare(`
    SELECT status, count(*) as n, coalesce(sum(bytes_total), 0) as bytes
    FROM uploads GROUP BY status
  `).all() as Array<{ status: string; n: number; bytes: number }>

  const total = stats.reduce((a, r) => a + r.n, 0)
  const done = stats.find(r => r.status === 'done')?.n || 0
  const errors = stats.find(r => r.status === 'error')?.n || 0
  const pending = stats.find(r => r.status === 'pending')?.n || 0
  const totalBytes = stats.reduce((a, r) => a + r.bytes, 0)
  const pct = total > 0 ? (100 * done / total).toFixed(1) : '0'

  const bySpace = db.prepare(`
    SELECT space_name,
      count(*) as total,
      sum(case when status='done' then 1 else 0 end) as done,
      sum(case when status='error' then 1 else 0 end) as errors,
      sum(case when status='pending' then 1 else 0 end) as pending,
      coalesce(sum(bytes_total), 0) as bytes
    FROM uploads GROUP BY space_name ORDER BY total DESC
  `).all() as Array<{ space_name: string; total: number; done: number; errors: number; pending: number; bytes: number }>

  const recentDone = db.prepare(`
    SELECT upload_root, space_name, shard_count, bytes_total, updated_at
    FROM uploads WHERE status = 'done' ORDER BY updated_at DESC LIMIT 10
  `).all() as Array<{ upload_root: string; space_name: string; shard_count: number; bytes_total: number; updated_at: string }>

  const recentErrors = db.prepare(`
    SELECT upload_root, space_name, updated_at
    FROM uploads WHERE status = 'error' ORDER BY updated_at DESC LIMIT 5
  `).all() as Array<{ upload_root: string; space_name: string; updated_at: string }>

  const fileCount = db.prepare(`SELECT count(*) as n, coalesce(sum(bytes), 0) as bytes FROM files`).get() as { n: number; bytes: number }

  // Read last 20 log lines if available
  let logLines = ''
  if (LOG_PATH) {
    try {
      const content = fs.readFileSync(LOG_PATH, 'utf-8')
      const lines = content.trim().split('\n').slice(-20)
      logLines = lines.map(l => escapeHtml(l)).join('\n')
    } catch {}
  }

  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

  function fmtBytes(b: number): string {
    if (b >= 1024 ** 4) return (b / 1024 ** 4).toFixed(1) + ' TiB'
    if (b >= 1024 ** 3) return (b / 1024 ** 3).toFixed(1) + ' GiB'
    if (b >= 1024 ** 2) return (b / 1024 ** 2).toFixed(0) + ' MiB'
    return (b / 1024).toFixed(0) + ' KiB'
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const spaceRows = bySpace.map(s => {
    const pct = s.total > 0 ? Math.round(100 * s.done / s.total) : 0
    const bar = `<div style="background:#2d2d2d;border-radius:3px;overflow:hidden;height:16px"><div style="background:#4ade80;height:100%;width:${pct}%"></div></div>`
    return `<tr>
      <td>${escapeHtml(s.space_name)}</td>
      <td>${s.done}</td><td>${s.errors}</td><td>${s.pending}</td><td>${s.total}</td>
      <td>${fmtBytes(s.bytes)}</td>
      <td style="min-width:100px">${bar} ${pct}%</td>
    </tr>`
  }).join('\n')

  const recentRows = recentDone.map(r =>
    `<tr><td>${escapeHtml(r.space_name)}</td><td><code>${r.upload_root.slice(0, 32)}...</code></td><td>${r.shard_count}</td><td>${fmtBytes(r.bytes_total)}</td><td>${r.updated_at}</td></tr>`
  ).join('\n')

  const errorRows = recentErrors.map(r =>
    `<tr><td>${escapeHtml(r.space_name)}</td><td><code>${r.upload_root.slice(0, 32)}...</code></td><td>${r.updated_at}</td></tr>`
  ).join('\n')

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="20">
<title>storacha-download</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a1a; color: #e0e0e0; margin: 0; padding: 20px; }
  h1 { color: #4ade80; margin: 0 0 4px; font-size: 1.4em; }
  .sub { color: #888; font-size: 0.85em; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .card { background: #2d2d2d; border-radius: 8px; padding: 16px; text-align: center; }
  .card .num { font-size: 1.8em; font-weight: bold; color: #fff; }
  .card .label { font-size: 0.8em; color: #888; margin-top: 4px; }
  .done .num { color: #4ade80; }
  .err .num { color: #f87171; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 0.9em; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #333; color: #888; }
  td { padding: 6px 8px; border-bottom: 1px solid #2d2d2d; }
  tr:hover { background: #252525; }
  code { font-size: 0.85em; color: #93c5fd; }
  h2 { color: #ccc; font-size: 1.1em; margin: 20px 0 8px; }
  .log { background: #111; border-radius: 6px; padding: 12px; font-family: monospace; font-size: 0.8em; white-space: pre-wrap; max-height: 300px; overflow-y: auto; color: #aaa; }
</style>
</head><body>
<h1>storacha-download</h1>
<div class="sub">Updated ${now} UTC &middot; Auto-refreshes every 20s</div>

<div class="grid">
  <div class="card"><div class="num">${total.toLocaleString()}</div><div class="label">Total Uploads</div></div>
  <div class="card done"><div class="num">${done.toLocaleString()}</div><div class="label">Complete (${pct}%)</div></div>
  <div class="card err"><div class="num">${errors}</div><div class="label">Errors</div></div>
  <div class="card"><div class="num">${pending.toLocaleString()}</div><div class="label">Pending</div></div>
  <div class="card"><div class="num">${fmtBytes(totalBytes)}</div><div class="label">Downloaded</div></div>
  <div class="card"><div class="num">${fileCount.n.toLocaleString()}</div><div class="label">CAR Files</div></div>
</div>

<h2>Per Space</h2>
<table>
<tr><th>Space</th><th>Done</th><th>Err</th><th>Pending</th><th>Total</th><th>Downloaded</th><th>Progress</th></tr>
${spaceRows}
</table>

<h2>Recently Completed</h2>
<table>
<tr><th>Space</th><th>Root CID</th><th>Shards</th><th>Size</th><th>Completed</th></tr>
${recentRows}
</table>

${errorRows ? `<h2>Recent Errors</h2>
<table>
<tr><th>Space</th><th>Root CID</th><th>Time</th></tr>
${errorRows}
</table>` : ''}

${logLines ? `<h2>Log</h2><div class="log">${logLines}</div>` : ''}

</body></html>`
}

// Write once immediately, then every 20s
const db = new Database(DB_PATH, { readonly: true })

function update() {
  try {
    const html = render(db)
    fs.writeFileSync(OUT_PATH, html)
  } catch (err: any) {
    console.error(`Dashboard write failed: ${err.message}`)
  }
}

update()
console.log(`Dashboard writing to ${OUT_PATH} every 20s`)
setInterval(update, 20000)

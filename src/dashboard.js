function sz(b) {
  if (!b) return '0 B'
  if (b < 1024) return b + ' B'
  if (b < 1024**2) return (b/1024).toFixed(1) + ' KiB'
  if (b < 1024**3) return (b/1024**2).toFixed(1) + ' MiB'
  if (b < 1024**4) return (b/1024**3).toFixed(1) + ' GiB'
  return (b/1024**4).toFixed(2) + ' TiB'
}

/**
 * Generate dashboard HTML from state.
 *
 * @param {object} state
 * @param {{ total: number, done: number, error: number, pending: number }} state.stats
 * @param {Array<{ space_name: string, done: number, errors: number, pending: number, active: number, total: number, bytes: number }>} state.bySpace
 * @param {Object<string, number>} state.spaceSizes
 * @param {Array<{ space_name: string, root_cid: string, updated_at: string }>} state.activeJobs
 * @param {Array<{ space_name: string, root_cid: string, bytes_transferred: number, updated_at: string }>} state.recentDone
 * @param {Array<{ space_name: string, root_cid: string, error_msg: string, updated_at: string }>} state.recentErrors
 * @param {string} state.logLines — pre-formatted, HTML-escaped log tail
 * @param {number} state.pid
 * @returns {string} HTML
 */
export function generateDashboardHtml({ stats, bySpace, spaceSizes, activeJobs, recentDone, recentErrors, logLines, pid }) {
  const { total, done, error: errors, pending } = stats
  const totalBytes = bySpace.reduce((s, r) => s + (r.bytes || 0), 0)
  const grandTotalBytes = Object.values(spaceSizes || {}).reduce((s, b) => s + b, 0)
  const pctDone = total > 0 ? (100 * done / total).toFixed(1) : 0
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)

  const spaceRows = bySpace.map(r => {
    const donePct = r.total > 0 ? Math.round(100 * r.done / r.total) : 0
    const errPct = r.total > 0 ? Math.round(100 * r.errors / r.total) : 0
    const spaceTotal = (spaceSizes || {})[r.space_name] || 0
    const statusClass = r.done === r.total && r.errors === 0 ? 'complete' : r.errors > 0 ? 'has-errors' : 'in-progress'
    return `
      <tr class="${statusClass}">
        <td class="space-name">${r.space_name || '?'}</td>
        <td class="num">${r.done}</td>
        <td class="num err">${r.errors || ''}</td>
        <td class="num">${r.pending}</td>
        <td class="num">${r.total}</td>
        <td class="num">${sz(r.bytes)}${spaceTotal > 0 ? ` (${sz(spaceTotal)})` : ''}</td>
        <td class="bar-cell">
          <div class="bar-bg"><div class="bar-fill" style="width:${donePct}%"></div><div class="bar-err" style="width:${errPct}%"></div></div>
          <span class="pct">${donePct}%</span>
        </td>
      </tr>`
  }).join('\n')

  const activeRows = (activeJobs || []).map(j => `
    <tr>
      <td>${j.space_name}</td>
      <td class="cid" title="${j.root_cid}">${j.root_cid.slice(0, 24)}...</td>
      <td>${j.updated_at || ''}</td>
    </tr>
  `).join('\n')

  const recentDoneRows = (recentDone || []).map(j => `
    <tr>
      <td>${j.space_name}</td>
      <td class="cid" title="${j.root_cid}">${j.root_cid.slice(0, 24)}...</td>
      <td class="num">${sz(j.bytes_transferred || 0)}</td>
      <td>${j.updated_at || ''}</td>
    </tr>
  `).join('\n')

  const errorRows = (recentErrors || []).map(e => `
    <tr>
      <td>${e.space_name}</td>
      <td class="cid" title="${e.root_cid}">${e.root_cid.slice(0, 24)}...</td>
      <td class="errmsg">${(e.error_msg || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>
      <td>${e.updated_at || ''}</td>
    </tr>
  `).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="refresh" content="5">
<title>Storacha Export Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --ff-blue-1: #EFF6FC; --ff-blue-2: #D8EBFB; --ff-blue-3: #73B4ED;
    --ff-blue-5: #154ED9; --ff-blue-7: #06094E; --ff-blue-8: #080B2E;
    --ff-bg: #0B0E3F; --ff-card: #ffffff; --ff-text: #1a1a2e;
    --ff-text-light: #4a5568; --ff-border: #e2e8f0;
    --green: #22c55e; --red: #ef4444; --yellow: #eab308; --orange: #f97316;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Archivo', sans-serif; background: #f7f8fc; color: var(--ff-text); }
  header {
    background: linear-gradient(160deg, var(--ff-blue-8) 0%, var(--ff-bg) 50%, var(--ff-blue-7) 100%);
    color: white; padding: 2rem 1.5rem 1.5rem; text-align: center;
  }
  header h1 { font-size: 1.8rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
  header p { font-size: 0.9rem; color: var(--ff-blue-3); }
  .container { max-width: 1100px; margin: 0 auto; padding: 1.5rem 1rem 3rem; }
  .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 2rem; }
  .kpi-card {
    background: var(--ff-card); border: 1px solid var(--ff-border);
    border-radius: 10px; padding: 1.2rem; text-align: center;
  }
  .kpi-card .label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ff-text-light); margin-bottom: 0.3rem; }
  .kpi-card .value { font-size: 2rem; font-weight: 800; }
  .kpi-card .sub { font-size: 0.8rem; color: var(--ff-text-light); margin-top: 0.2rem; }
  .kpi-card.green .value { color: var(--green); }
  .kpi-card.red .value { color: var(--red); }
  .kpi-card.blue .value { color: var(--ff-blue-5); }
  .kpi-card.orange .value { color: var(--orange); }

  .overall-bar { background: #e2e8f0; border-radius: 8px; height: 24px; margin-bottom: 2rem; overflow: hidden; position: relative; }
  .overall-fill { background: linear-gradient(90deg, var(--ff-blue-5), var(--green)); height: 100%; transition: width 0.5s; border-radius: 8px; }
  .overall-label { position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%); font-weight: 700; font-size: 0.85rem; color: #333; }

  h2 { font-size: 1.1rem; font-weight: 700; margin-bottom: 0.75rem; color: var(--ff-blue-7); }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; margin-bottom: 2rem; }
  th { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 2px solid var(--ff-border); font-weight: 600; color: var(--ff-text-light); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; }
  td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #f0f0f0; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .err { color: var(--red); font-weight: 600; }
  .space-name { font-weight: 600; }
  .bar-cell { width: 200px; }
  .bar-bg { background: #e2e8f0; border-radius: 4px; height: 14px; display: flex; width: 140px; vertical-align: middle; overflow: hidden; }
  .bar-fill { background: var(--ff-blue-5); height: 100%; border-radius: 4px 0 0 4px; transition: width 0.3s; }
  .bar-err { background: var(--red); height: 100%; border-radius: 0; transition: width 0.3s; }
  .complete .bar-fill { background: var(--green); border-radius: 4px; }
  .pct { font-size: 0.75rem; color: var(--ff-text-light); margin-left: 0.4rem; }
  .cid { font-family: monospace; font-size: 0.78rem; }
  .errmsg { font-size: 0.78rem; color: var(--red); word-break: break-word; }
  .timestamp { font-size: 0.75rem; color: var(--ff-text-light); text-align: center; margin-top: 1rem; }

  .log-panel {
    background: var(--ff-blue-8); color: #c8d6e5; border-radius: 8px;
    padding: 1rem; font-family: 'Menlo', 'Consolas', monospace; font-size: 0.75rem;
    line-height: 1.5; overflow-x: auto; white-space: pre; max-height: 400px;
    overflow-y: auto; margin-bottom: 2rem;
  }
  .log-panel .log-error { color: #ef4444; }
  .log-panel .log-warn { color: #eab308; }
  .log-panel .log-repair { color: #a78bfa; }
  .log-panel .log-done { color: #22c55e; }
</style>
</head>
<body>
<header>
  <h1>Storacha Export Dashboard</h1>
  <p>PID ${pid} &middot; Updated ${now} UTC</p>
</header>
<div class="container">
  <div class="kpi-grid">
    <div class="kpi-card blue"><div class="label">Total Uploads</div><div class="value">${total.toLocaleString()}</div></div>
    <div class="kpi-card green"><div class="label">Done</div><div class="value">${done.toLocaleString()}</div><div class="sub">${pctDone}%</div></div>
    <div class="kpi-card ${errors > 0 ? 'red' : ''}"><div class="label">Errors</div><div class="value">${errors}</div></div>
    <div class="kpi-card orange"><div class="label">Pending</div><div class="value">${pending.toLocaleString()}</div></div>
    <div class="kpi-card blue"><div class="label">Downloaded</div><div class="value">${sz(totalBytes)}</div>${grandTotalBytes > 0 ? `<div class="sub">(${sz(grandTotalBytes)} stored)</div>` : ''}</div>
  </div>

  <div class="overall-bar">
    <div class="overall-fill" style="width:${pctDone}%"></div>
    <div class="overall-label">${pctDone}% complete</div>
  </div>

  <h2>Per Space</h2>
  <table>
    <thead><tr><th>Space</th><th style="text-align:right">Done</th><th style="text-align:right">Err</th><th style="text-align:right">Pending</th><th style="text-align:right">Total</th><th style="text-align:right">Downloaded (Stored)</th><th>Progress</th></tr></thead>
    <tbody>${spaceRows}</tbody>
  </table>

  ${activeJobs?.length > 0 ? `<h2>Active Now</h2>
  <table>
    <thead><tr><th>Space</th><th>CID</th><th>Started</th></tr></thead>
    <tbody>${activeRows}</tbody>
  </table>` : ''}

  ${recentDone?.length > 0 ? `<h2>Recently Completed</h2>
  <table>
    <thead><tr><th>Space</th><th>CID</th><th style="text-align:right">Size</th><th>Time</th></tr></thead>
    <tbody>${recentDoneRows}</tbody>
  </table>` : ''}

  ${recentErrors?.length > 0 ? `<h2>Recent Errors</h2>
  <table>
    <thead><tr><th>Space</th><th>CID</th><th>Error</th><th>Time</th></tr></thead>
    <tbody>${errorRows}</tbody>
  </table>` : ''}

  <h2>Live Log</h2>
  <div class="log-panel" id="logPanel">${logLines || '<span style="color:#4a5568">No log output yet</span>'}</div>

  <div class="timestamp">Last updated: ${now} UTC &middot; Auto-refreshes every 5s</div>
<script>document.getElementById('logPanel').scrollTop = document.getElementById('logPanel').scrollHeight;</script>
</div>
</body>
</html>`
}

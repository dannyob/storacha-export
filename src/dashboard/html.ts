export interface DashboardState {
  phase: 'discovery' | 'export' | 'verify'
  pid: number
  stats: {
    total: number
    complete: number
    error: number
    pending: number
    downloading: number
    partial: number
    repairing: number
    total_bytes: number
  }
  bySpace: Array<{
    space_name: string
    done: number
    errors: number
    pending: number
    active: number
    total: number
    bytes: number
  }>
  spaceSizes: Map<string, number>
  activeJobs: Array<{ space_name: string; root_cid: string; status: string }>
  recentDone: Array<{ space_name: string; root_cid: string }>
  recentErrors: Array<{ space_name: string; root_cid: string; error_msg: string | null }>
  logLines: string[]
  statusMessage?: string
}

import { filesize } from '../util/format.js'

function phaseLabel(phase: DashboardState['phase']): string {
  if (phase === 'discovery') return 'Discovery'
  if (phase === 'export') return 'Export'
  return 'Verify'
}

export function generateDashboardHtml(state: DashboardState, options?: { staticFile?: boolean }): string {
  const { phase, pid, stats, bySpace, spaceSizes, activeJobs, recentDone, recentErrors, logLines } = state
  const total = stats.total ?? 0
  const complete = stats.complete ?? 0
  const errors = stats.error ?? 0
  const pending = stats.pending ?? 0
  const downloading = stats.downloading ?? 0
  const repairing = stats.repairing ?? 0
  const totalBytes = bySpace.reduce((s, r) => s + (r.bytes || 0), 0)
  let grandTotalBytes = 0
  for (const v of spaceSizes.values()) grandTotalBytes += v
  const pctDone = total > 0 ? (100 * complete / total).toFixed(1) : '0.0'
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
  const label = phaseLabel(phase)

  const spaceRows = bySpace.map(r => {
    const donePct = r.total > 0 ? Math.round(100 * r.done / r.total) : 0
    const errPct = r.total > 0 ? Math.round(100 * r.errors / r.total) : 0
    const spaceTotal = spaceSizes.get(r.space_name) ?? 0
    const statusClass = r.done === r.total && r.errors === 0 ? 'complete' : r.errors > 0 ? 'has-errors' : 'in-progress'
    return `
      <tr class="${statusClass}">
        <td class="space-name">${r.space_name || '?'}</td>
        <td class="num">${r.done}</td>
        <td class="num err">${r.errors || ''}</td>
        <td class="num">${r.pending}</td>
        <td class="num">${r.total}</td>
        <td class="num">${filesize(r.bytes)}${spaceTotal > 0 ? ` (${filesize(spaceTotal)})` : ''}</td>
        <td class="bar-cell">
          <div class="bar-bg"><div class="bar-fill" style="width:${donePct}%"></div><div class="bar-err" style="width:${errPct}%"></div></div>
          <span class="pct">${donePct}%</span>
        </td>
      </tr>`
  }).join('\n')

  function cidLink(cid: string, truncate = true): string {
    const display = truncate ? cid.slice(0, 24) + '...' : cid
    return `<a href="https://${cid}.ipfs.inbrowser.link" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline dotted;text-underline-offset:2px">${display}</a>`
  }

  const activeRows = activeJobs.map(j => `
    <tr>
      <td>${j.space_name}</td>
      <td class="cid">${cidLink(j.root_cid)}</td>
      <td>${j.status}</td>
    </tr>
  `).join('\n')

  const recentDoneRows = recentDone.map(j => `
    <tr>
      <td>${j.space_name}</td>
      <td class="cid">${cidLink(j.root_cid, false)}</td>
    </tr>
  `).join('\n')

  const errorRows = recentErrors.map(e => `
    <tr>
      <td>${e.space_name}</td>
      <td class="cid">${cidLink(e.root_cid, false)}</td>
      <td class="errmsg">${(e.error_msg || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</td>
    </tr>
  `).join('\n')

  function colorizeLogLine(line: string): string {
    const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    return escaped
      .replace(/\b(DONE)\b/, '<span style="color:#22c55e;font-weight:600">$1</span>')
      .replace(/\b(ERROR)\b/, '<span style="color:#ef4444;font-weight:600">$1</span>')
      .replace(/\b(RETRY)\b/, '<span style="color:#eab308;font-weight:600">$1</span>')
      .replace(/\b(REPAIR)\b/, '<span style="color:#a78bfa;font-weight:600">$1</span>')
      .replace(/\b(DOWNLOADING)\b/, '<span style="color:#38bdf8;font-weight:600">$1</span>')
      .replace(/\b(VERIFY OK)\b/, '<span style="color:#22c55e;font-weight:600">$1</span>')
      .replace(/\b(VERIFY FAIL)\b/, '<span style="color:#ef4444;font-weight:600">$1</span>')
      .replace(/\b(VERIFY)\b(?! OK| FAIL)/, '<span style="color:#818cf8;font-weight:600">$1</span>')
      .replace(/\b(INFO)\b/, '<span style="color:#94a3b8">$1</span>')
  }

  const logContent = logLines.length > 0
    ? logLines.map(colorizeLogLine).join('\n')
    : '<span style="color:#4a5568">No log output yet</span>'

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
${options?.staticFile ? '<meta http-equiv="refresh" content="5">' : ''}
<title>storacha-export Dashboard</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>
  :root {
    --ff-blue-1: #EFF6FC; --ff-blue-2: #D8EBFB; --ff-blue-3: #73B4ED;
    --ff-blue-5: #154ED9; --ff-blue-7: #06094E; --ff-blue-8: #080B2E;
    --ff-bg: #0B0E3F; --ff-card: #ffffff; --ff-text: #1a1a2e;
    --ff-text-light: #4a5568; --ff-border: #e2e8f0;
    --green: #22c55e; --red: #ef4444; --yellow: #eab308; --orange: #f97316; --purple: #a78bfa;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Archivo', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f7f8fc; color: var(--ff-text); }
  header {
    background: linear-gradient(160deg, var(--ff-blue-8) 0%, var(--ff-bg) 50%, var(--ff-blue-7) 100%);
    color: white; padding: 2rem 1.5rem 1.5rem; text-align: center;
  }
  header h1 { font-size: 1.8rem; font-weight: 800; letter-spacing: -0.02em; margin-bottom: 0.25rem; }
  header p { font-size: 0.9rem; color: var(--ff-blue-3); }
  .phase-badge {
    display: inline-block; background: rgba(255,255,255,0.15); border-radius: 20px;
    padding: 0.2rem 0.8rem; font-size: 0.85rem; font-weight: 600; margin-top: 0.5rem;
  }
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
  <h1>storacha-export</h1>
  <p>PID: ${pid} &middot; Updated ${now} UTC</p>
  <div class="phase-badge">${label}</div>
  ${state.statusMessage ? `<p style="margin-top:0.5rem;color:var(--ff-blue-2);font-size:0.9rem">${state.statusMessage.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>` : ''}
</header>
<div class="container">
  <div class="kpi-grid">
    <div class="kpi-card blue"><div class="label">Total Uploads</div><div class="value">${total.toLocaleString()}</div></div>
    <div class="kpi-card green"><div class="label">Complete</div><div class="value">${complete.toLocaleString()}</div><div class="sub">${pctDone}%</div></div>
    ${downloading > 0 ? `<div class="kpi-card blue"><div class="label">Downloading</div><div class="value">${downloading}</div></div>` : ''}
    ${repairing > 0 ? `<div class="kpi-card" style="border-color:var(--purple)"><div class="label">Repairing</div><div class="value" style="color:var(--purple)">${repairing}</div></div>` : ''}
    <div class="kpi-card ${errors > 0 ? 'red' : ''}"><div class="label">Errors</div><div class="value">${errors}</div></div>
    <div class="kpi-card orange"><div class="label">Pending</div><div class="value">${pending.toLocaleString()}</div></div>
    <div class="kpi-card blue"><div class="label">Transferred</div><div class="value">${filesize(totalBytes)}</div>${grandTotalBytes > 0 ? `<div class="sub">(${filesize(grandTotalBytes)} total)</div>` : ''}</div>
  </div>

  <div class="overall-bar">
    <div class="overall-fill" style="width:${pctDone}%"></div>
    <div class="overall-label">${pctDone}% complete</div>
  </div>

  <h2>Per Space</h2>
  <table>
    <thead><tr><th>Space</th><th style="text-align:right">Done</th><th style="text-align:right">Err</th><th style="text-align:right">Pending</th><th style="text-align:right">Total</th><th style="text-align:right">Transferred (Total)</th><th>Progress</th></tr></thead>
    <tbody>${spaceRows}</tbody>
  </table>

  ${activeJobs.length > 0 ? `<h2>Active Now</h2>
  <table>
    <thead><tr><th>Space</th><th>CID</th><th>Status</th></tr></thead>
    <tbody>${activeRows}</tbody>
  </table>` : ''}

  ${recentDone.length > 0 ? `<h2>Recently Completed</h2>
  <table>
    <thead><tr><th>Space</th><th>CID</th></tr></thead>
    <tbody>${recentDoneRows}</tbody>
  </table>` : ''}

  ${recentErrors.length > 0 ? `<h2>Recent Errors</h2>
  <table>
    <thead><tr><th>Space</th><th>CID</th><th>Error</th></tr></thead>
    <tbody>${errorRows}</tbody>
  </table>` : ''}

  <h2>Live Log</h2>
  <div class="log-panel" id="logPanel">${logContent}</div>

  <div class="timestamp">Last updated: ${now} UTC &middot; Auto-refreshes every 5s</div>
<script>
document.getElementById('logPanel').scrollTop = document.getElementById('logPanel').scrollHeight;
${options?.staticFile ? '' : `setInterval(async () => {
  try {
    const r = await fetch(location.href);
    const html = await r.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const newHeader = doc.querySelector('header');
    const newBody = doc.querySelector('.container');
    if (newHeader) document.querySelector('header').innerHTML = newHeader.innerHTML;
    if (newBody) document.querySelector('.container').innerHTML = newBody.innerHTML;
    document.getElementById('logPanel').scrollTop = document.getElementById('logPanel').scrollHeight;
  } catch {}
}, 3000);`}
</script>
</div>
</body>
</html>`
}

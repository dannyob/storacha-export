# Integrated Dashboard Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan.

**Goal:** Move the dashboard into the export process itself so it has accurate state, and remove the external dashboard script.

**Architecture:** A tiny HTTP server started as a side-effect of the export, serving a static HTML page generated from in-process state. Optionally writes the same HTML to disk for external web servers.

**Tech Stack:** Node `http.createServer`, existing HTML generation logic

---

### Task 1: Create `src/server.js`

**Files:**
- Create: `src/server.js`

- [ ] **Step 1: Write the server module**

```js
// src/server.js
import http from 'node:http'

export function startDashboard(options = {}) {
  const { host = '127.0.0.1', port = 0, password, getHtml } = options

  const server = http.createServer((req, res) => {
    // Basic auth check
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
      const addr = server.address()
      resolve({ server, url: `http://${addr.address}:${addr.port}` })
    })
  })
}
```

- [ ] **Step 2: Verify it loads**

```bash
node -e "import('./src/server.js').then(() => console.log('ok'))"
```

- [ ] **Step 3: Commit**

```bash
git add src/server.js
git commit -m "feat: add dashboard HTTP server module"
```

---

### Task 2: Create `src/dashboard.js` (refactored from external script)

**Files:**
- Create: `src/dashboard.js` (the HTML generator, not a standalone script)

- [ ] **Step 1: Write the dashboard HTML generator**

Move the HTML generation logic from the external `/tmp/storacha-dashboard.js` into a module that takes state as a parameter instead of reading from the DB directly.

The function signature:

```js
export function generateDashboardHtml({
  stats,           // { total, done, error, pending }
  bySpace,         // [{ space_name, done, errors, pending, active, total, bytes }]
  spaceSizes,      // Map<name, totalBytes>
  activeJobs,      // [{ space_name, root_cid, updated_at }]
  recentDone,      // [{ space_name, root_cid, bytes_transferred, updated_at }]
  recentErrors,    // [{ space_name, root_cid, error_msg, updated_at }]
  logLines,        // string (pre-formatted, HTML-escaped log tail)
  pid,             // number
})
```

Keep all existing CSS and HTML structure. Remove:
- Process status detection (ps aux) — replaced by PID display
- DB reads — all data passed in
- File writing — caller decides what to do with the HTML string

- [ ] **Step 2: Verify it loads**

```bash
node -e "import('./src/dashboard.js').then(() => console.log('ok'))"
```

- [ ] **Step 3: Commit**

```bash
git add src/dashboard.js
git commit -m "feat: refactor dashboard HTML generation into importable module"
```

---

### Task 3: Integrate into CLI

**Files:**
- Modify: `src/cli.js`

- [ ] **Step 1: Add CLI flags**

Add to commander options:

```js
.option('--serve [host:port]', 'Start dashboard HTTP server (default: 127.0.0.1, random port)')
.option('--serve-password <pass>', 'HTTP Basic Auth password for dashboard')
.option('--html-out <path>', 'Write dashboard HTML to file periodically')
```

- [ ] **Step 2: Add dashboard state collector**

Create a function in cli.js that queries the DB and returns the state object for `generateDashboardHtml`. Also maintains a ring buffer of recent log lines (captured from the `onProgress` callback).

```js
function collectDashboardState(queue, selectedSpaces, logBuffer) {
  // Query DB for stats, bySpace, activeJobs, recentDone, recentErrors
  // Filter by selectedSpaces
  // Return the state object
}
```

- [ ] **Step 3: Start server and periodic HTML writer before execute phase**

After backends are initialized and before `executeAll`:

```js
if (opts.serve !== undefined) {
  const [host, port] = parseServeFlag(opts.serve)
  const { url } = await startDashboard({
    host, port,
    password: opts.servePassword,
    getHtml: () => generateDashboardHtml(collectDashboardState(queue, selectedSpaces, logBuffer)),
  })
  console.log(`Dashboard: ${url}`)
}

let htmlOutInterval
if (opts.htmlOut) {
  htmlOutInterval = setInterval(() => {
    const html = generateDashboardHtml(collectDashboardState(queue, selectedSpaces, logBuffer))
    fs.writeFileSync(opts.htmlOut, html)
  }, 5000)
}
```

- [ ] **Step 4: Capture log lines for the dashboard**

Add a ring buffer (last 50 lines) in the `onProgress` callback that the dashboard reads:

```js
const logBuffer = []
const MAX_LOG_LINES = 50

function addLogLine(level, msg) {
  logBuffer.push(`${ts()} [${process.pid}] ${level} ${msg}`)
  if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift()
}
```

Wire this into the existing `log()` calls and `onProgress` handler.

- [ ] **Step 5: Clean up on exit**

After `executeAll` completes:

```js
if (htmlOutInterval) clearInterval(htmlOutInterval)
// Final HTML write
if (opts.htmlOut) {
  fs.writeFileSync(opts.htmlOut, generateDashboardHtml(...))
}
```

- [ ] **Step 6: Run tests**

```bash
npm test
```

- [ ] **Step 7: Commit**

```bash
git add src/cli.js
git commit -m "feat: integrate dashboard server and HTML output into export process"
```

---

### Task 4: Update `run.sh` and clean up external scripts

**Files:**
- Modify: `run.sh` (on fatfil)
- Delete: external `dashboard.js`, `status.js`

- [ ] **Step 1: Simplify `run.sh`**

```bash
#!/bin/bash
trap "" HUP
cd ~/storacha-export
node bin/storacha-export.js \
  --backend kubo --kubo-api http://127.0.0.1:5001 \
  --serve 0.0.0.0:8087 \
  --html-out /store/fastphils/www/storacha-export.html \
  "$@"
```

No more dashboard loop — the process does it all.

- [ ] **Step 2: Commit**

```bash
git add run.sh
git commit -m "chore: simplify run.sh — dashboard now integrated into export process"
```

---

### Task 5: Add DB queries needed by dashboard

**Files:**
- Modify: `src/queue.js`

- [ ] **Step 1: Add dashboard-specific queries**

The dashboard needs per-space stats filtered by a space list. Add:

```js
getStatsBySpace(spaceNames) {
  // Returns [{ space_name, done, errors, pending, active, total, bytes }]
  // filtered to given space names
}

getActiveJobs(limit = 5) {
  // Returns in_progress jobs
}

getRecentDone(limit = 5) {
  // Returns recently completed jobs
}

getRecentErrors(limit = 10) {
  // Returns recent errors
}
```

- [ ] **Step 2: Run tests**

```bash
npm test
```

- [ ] **Step 3: Commit**

```bash
git add src/queue.js
git commit -m "feat: add dashboard query methods to JobQueue"
```

---

### Task 6: Test manually on fatfil

- [ ] **Step 1: Push all files to fatfil**
- [ ] **Step 2: Restart export with `--serve 0.0.0.0:8087 --html-out /store/fastphils/www/storacha-export.html`**
- [ ] **Step 3: Verify dashboard at `http://fatfil:8087` and `https://fastphils.org/storacha-export.html`**
- [ ] **Step 4: Verify log lines appear in dashboard**
- [ ] **Step 5: Verify excluded spaces don't appear**

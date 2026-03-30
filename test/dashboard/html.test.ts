import { describe, it, expect } from 'vitest'
import { generateDashboardHtml } from '../../src/dashboard/html.js'

describe('generateDashboardHtml', () => {
  it('produces valid HTML with KPI cards', () => {
    const html = generateDashboardHtml({
      phase: 'export',
      pid: 12345,
      stats: { total: 10, complete: 5, error: 1, pending: 3, downloading: 1, partial: 0, repairing: 0, total_bytes: 50000 },
      bySpace: [
        { space_name: 'TestSpace', done: 5, errors: 1, pending: 3, active: 1, total: 10, bytes: 50000 },
      ],
      spaceSizes: new Map([['TestSpace', 100000]]),
      activeJobs: [{ space_name: 'TestSpace', root_cid: 'bafytest123', status: 'downloading' }],
      recentDone: [],
      recentErrors: [],
      logLines: ['2026-03-30 00:00:00 [12345] INFO test log line'],
    })

    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('storacha-export')
    expect(html).toContain('PID: 12345')
    expect(html).toContain('TestSpace')
    expect(html).toContain('Export')  // phase indicator
  })

  it('shows all three phases', () => {
    const base = {
      pid: 1, stats: { total: 0, complete: 0, error: 0, pending: 0, downloading: 0, partial: 0, repairing: 0, total_bytes: 0 },
      bySpace: [], spaceSizes: new Map(), activeJobs: [], recentDone: [], recentErrors: [], logLines: [],
    }

    expect(generateDashboardHtml({ ...base, phase: 'discovery' })).toContain('Discovery')
    expect(generateDashboardHtml({ ...base, phase: 'export' })).toContain('Export')
    expect(generateDashboardHtml({ ...base, phase: 'verify' })).toContain('Verify')
  })
})

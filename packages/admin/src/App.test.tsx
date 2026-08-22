import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react'
import App from './App'

/**
 * Smoke coverage for the dashboard shell: it must mount, survive the initial
 * data fetch, and render what the proxy reports. The API layer is stubbed at
 * the fetch boundary so no server is required.
 *
 * The dashboard is served unauthenticated, so every test that wants data has to
 * sign in first — which is the point of the gate.
 */

const stats = { decisions: { forwarded: 12, blocked: 3 }, errors: 1 }
const rules = [
  { id: 'ga4', category: 'analytics', endpoints: ['google-analytics.com'], transformations: [] },
]
const logs = [
  {
    seq: 2,
    userId: 'u_abcdef123456',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent granted',
    timestamp: '2026-08-22T10:00:00.000Z',
    transformations: [{ path: 'user_id', action: 'hash', matched: 1 }],
  },
  {
    seq: 1,
    userId: 'u_zzzzzz999999',
    destination: 'mixpanel',
    decision: 'blocked',
    reason: 'no consent',
    timestamp: '2026-08-22T10:00:01.000Z',
    transformations: [],
  },
  {
    seq: 0,
    userId: 'u_detected00001',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent granted',
    timestamp: '2026-08-22T10:00:02.000Z',
    transformations: [{ path: 'ep.note', action: 'redact', matched: 2, detector: 'email' }],
  },
]

const health = {
  status: 'ok',
  storage: { kind: 'RedisStorageProvider', ok: true, latencyMs: 4, error: null },
  audit: {
    configured: true,
    kind: 'file',
    healthy: true,
    location: '/srv/sluice/.sluice/audit',
    entries: 4210,
    oldest: '2026-06-01T09:00:00.000Z',
    newest: '2026-08-22T10:00:02.000Z',
    retentionDays: 90,
    head: { seq: 4209, hash: 'a'.repeat(64) },
    lastError: null,
    cacheEntries: 1000,
    required: true,
    evidenceAvailable: true,
  },
  detectors: ['email', 'phone'],
  uptimeSeconds: 120,
}

const ruleHealth = {
  destinations: [
    {
      destination: 'ga4',
      declared: [
        { path: 'user_id', action: 'hash', matched: 12, lastFiredAt: '2026-08-22T10:00:00.000Z' },
        { path: 'events.*.params.email', action: 'strip', matched: 0, lastFiredAt: null },
      ],
      detected: [{ detector: 'email', matched: 2 }],
    },
  ],
  recordsScanned: 4210,
  scanLimit: 20000,
  truncated: false,
}

function respond(body: unknown) {
  return {
    ok: true,
    json: async () => body,
    blob: async () => new Blob([JSON.stringify(body)]),
  } as unknown as Response
}

function stubApi(overrides: Record<string, unknown> = {}) {
  return vi.fn(async (url: any) => {
    const u = String(url)
    for (const [fragment, body] of Object.entries(overrides)) {
      if (u.includes(fragment)) return respond(body)
    }
    if (u.includes('/api/stats')) return respond(stats)
    if (u.includes('/api/rules')) return respond(rules)
    if (u.includes('/api/rule-health')) return respond(ruleHealth)
    if (u.includes('/api/health')) return respond(health)
    if (u.includes('/audit/verify')) return respond({ status: 'intact', checked: 4210, head: null })
    if (u.includes('/audit')) return respond({ records: logs, nextCursor: null, scanned: 3 })
    return respond({})
  })
}

function signIn(token = 'test-admin') {
  sessionStorage.setItem('sluice_admin_token', token)
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  globalThis.fetch = stubApi() as unknown as typeof fetch
  sessionStorage.clear()
})

afterEach(() => {
  cleanup()
  sessionStorage.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/**
 * The admin bearer used to be compiled into the bundle by Vite, which the proxy
 * then served to anyone who opened /dashboard. It is entered at runtime now, so
 * the dashboard must ask for it and must not call the proxy before it has one.
 */
describe('admin token gate', () => {
  it('asks for a token instead of loading data when none is stored', () => {
    render(<App />)
    expect(screen.getByLabelText('Admin token')).toBeDefined()
    expect((globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
  })

  it('loads the dashboard with the token the operator types in', async () => {
    render(<App />)
    fireEvent.change(screen.getByLabelText('Admin token'), { target: { value: 'typed-token' } })
    fireEvent.click(screen.getByText('Unlock'))

    await waitFor(() => expect(screen.getByText('u_abcdef123456')).toBeDefined())
    const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
    expect((calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer typed-token',
    })
  })

  it('sends the token in a header, never in the page it was typed into', async () => {
    signIn('typed-token')
    render(<App />)
    await waitFor(() => expect(screen.getByText('u_abcdef123456')).toBeDefined())
    expect(document.body.innerHTML).not.toContain('typed-token')
  })

  it('re-prompts and forgets the token when the proxy rejects it', async () => {
    signIn('stale-token')
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    ) as unknown as typeof fetch

    render(<App />)
    await waitFor(() => expect(screen.getByLabelText('Admin token')).toBeDefined())
    expect(sessionStorage.getItem('sluice_admin_token')).toBeNull()
  })
})

describe('App', () => {
  beforeEach(() => signIn())

  it('mounts and renders the product name', async () => {
    render(<App />)
    expect(screen.getByText('Sluice')).toBeDefined()
  })

  it('renders the counters returned by the proxy', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('12')).toBeDefined()
      expect(screen.getByText('3')).toBeDefined()
    })
  })

  it('renders audit rows for each log entry', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText('u_abcdef123456')).toBeDefined()
      expect(screen.getByText('u_zzzzzz999999')).toBeDefined()
    })
  })

  it('shows a scrub indicator only for records that carry transformation evidence', async () => {
    render(<App />)
    // The forwarded ga4 record scrubbed one field; the blocked mixpanel record
    // scrubbed nothing and must not be labelled as though it had.
    await waitFor(() => expect(screen.getAllByText('1 scrubbed').length).toBeGreaterThan(0))
    expect(screen.queryByText('0 scrubbed')).toBeNull()
  })

  it('says which entries the value scan found, rather than crediting them to a rule', async () => {
    render(<App />)
    await waitFor(() =>
      expect(screen.getAllByTitle('redact ep.note (×2, detected email)').length).toBeGreaterThan(0),
    )
    expect(screen.getAllByTitle('hash user_id (×1, declared rule)').length).toBeGreaterThan(0)
  })

  it('survives an API failure without crashing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    globalThis.fetch = vi.fn(async () => {
      throw new Error('proxy offline')
    }) as unknown as typeof fetch

    render(<App />)
    // The shell still renders even though every request failed.
    await waitFor(() => expect(screen.getByText('Sluice')).toBeDefined())
    expect(consoleError).toHaveBeenCalled()
  })

  it('polls the proxy on an interval', async () => {
    render(<App />)
    const callsAfterMount = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .length
    expect(callsAfterMount).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(5000)
    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length
      expect(calls).toBeGreaterThan(callsAfterMount)
    })
  })
})

/**
 * The dashboard used to state things it had never measured: "System Healthy"
 * and "Redis: Connected" were literals, and Coverage was rules.length / 50.
 * These pin every operator-facing claim to something the proxy reported.
 */
describe('operator surfaces report what was measured', () => {
  beforeEach(() => signIn())

  it('renders the storage probe result rather than a fixed string', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('System healthy')).toBeDefined())
    expect(screen.getByText('Redis: responding in 4ms')).toBeDefined()
  })

  it('says degraded when the proxy says degraded', async () => {
    globalThis.fetch = stubApi({
      '/api/health': {
        ...health,
        status: 'degraded',
        storage: { kind: 'RedisStorageProvider', ok: false, latencyMs: 101, error: 'timeout' },
      },
    }) as unknown as typeof fetch

    render(<App />)
    await waitFor(() => expect(screen.getByText('System degraded')).toBeDefined())
    expect(screen.getByText('Redis: not responding')).toBeDefined()
    expect(screen.queryByText('System healthy')).toBeNull()
  })

  it('shows how much evidence is retained and how far back', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('4,210')).toBeDefined())
    expect(screen.getByText('Records retained for 90 days')).toBeDefined()
    expect(screen.getByText('/srv/sluice/.sluice/audit')).toBeDefined()
    expect(screen.getByText(/#4209 aaaaaaaaaaaa/)).toBeDefined()
  })

  it('warns when there is no durable record at all', async () => {
    globalThis.fetch = stubApi({
      '/api/health': { ...health, audit: { ...health.audit, configured: false, entries: 0 } },
    }) as unknown as typeof fetch

    render(<App />)
    await waitFor(() => expect(screen.getByText('No durable audit record.')).toBeDefined())
    expect(screen.getByText(/1000-entry cache that rolls over/)).toBeDefined()
  })

  it('says when the firewall has stopped forwarding for want of a record', async () => {
    globalThis.fetch = stubApi({
      '/api/health': {
        ...health,
        status: 'degraded',
        audit: { ...health.audit, healthy: false, evidenceAvailable: false, lastError: 'ENOSPC' },
      },
    }) as unknown as typeof fetch

    render(<App />)
    await waitFor(() =>
      expect(screen.getByText('Not recording — forwarding stopped')).toBeDefined(),
    )
  })

  it('reports the chain state the proxy verified, including a broken one', async () => {
    globalThis.fetch = stubApi({
      '/audit/verify': {
        status: 'broken',
        checked: 12,
        head: null,
        brokenAt: 7,
        reason: 'record 7 has been altered since it was written',
      },
    }) as unknown as typeof fetch

    render(<App />)
    await waitFor(() => expect(screen.getByText('Verify chain')).toBeDefined())
    fireEvent.click(screen.getByText('Verify chain'))

    await waitFor(() => expect(screen.getByText('Chain broken at seq 7')).toBeDefined())
    expect(screen.getByText('record 7 has been altered since it was written')).toBeDefined()
  })

  it('no longer shows a coverage percentage against a made-up denominator', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('u_abcdef123456')).toBeDefined())
    fireEvent.click(screen.getByText('Registry'))

    expect(screen.getByText('Total Rules')).toBeDefined()
    expect(screen.queryByText('Coverage')).toBeNull()
    expect(screen.queryByText('Of global destination registry')).toBeNull()
  })

  it('marks a declared path that has never fired as a dead rule', async () => {
    globalThis.fetch = stubApi({
      '/api/rules': [
        {
          id: 'ga4',
          category: 'analytics',
          endpoints: ['google-analytics.com'],
          transformations: [
            { path: 'user_id', action: 'hash' },
            { path: 'events.*.params.email', action: 'strip' },
          ],
        },
      ],
    }) as unknown as typeof fetch

    render(<App />)
    await waitFor(() => expect(screen.getByText('u_abcdef123456')).toBeDefined())
    fireEvent.click(screen.getByText('Governance'))

    await waitFor(() => expect(screen.getByText('hash:user_id ×12')).toBeDefined())
    const dead = screen.getByText('strip:events.*.params.email ×0')
    expect(dead.getAttribute('title')).toMatch(/Never fired/)
  })
})

/**
 * The audit view is how the record gets produced for someone who asked for it,
 * so the filter has to reach the proxy rather than trim a page in the browser.
 */
describe('audit query and export', () => {
  beforeEach(() => signIn())

  async function openAudit() {
    render(<App />)
    await waitFor(() => expect(screen.getByText('u_abcdef123456')).toBeDefined())
    fireEvent.click(screen.getByText('Audit Log'))
  }

  it('sends the filter to the proxy instead of narrowing a stale page', async () => {
    await openAudit()
    fireEvent.change(screen.getByLabelText('Destination'), { target: { value: 'ga4' } })

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some(([url]) => String(url).includes('/audit?destination=ga4'))).toBe(true)
    })
  })

  it('filters by the detector that found the data', async () => {
    await openAudit()
    fireEvent.change(screen.getByLabelText('Detector'), { target: { value: 'email' } })

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some(([url]) => String(url).includes('detector=email'))).toBe(true)
    })
  })

  it('asks for older records only when the proxy said there are some', async () => {
    globalThis.fetch = stubApi({
      '/audit': { records: logs, nextCursor: 0, scanned: 3 },
    }) as unknown as typeof fetch

    await openAudit()
    fireEvent.click(screen.getByText('Load older records'))

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.some(([url]) => String(url).includes('cursor=0'))).toBe(true)
    })
  })

  it('exports the filtered record, carrying the filter into the download', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    URL.createObjectURL = vi.fn(() => 'blob:audit')
    URL.revokeObjectURL = vi.fn()

    await openAudit()
    fireEvent.change(screen.getByLabelText('Decision'), { target: { value: 'blocked' } })
    fireEvent.click(screen.getByText('Export CSV'))

    await waitFor(() => {
      const calls = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      const exportCall = calls.find(([url]) => String(url).includes('format=csv'))
      expect(exportCall).toBeDefined()
      expect(String(exportCall![0])).toContain('decision=blocked')
    })
    expect(click).toHaveBeenCalled()
  })
})

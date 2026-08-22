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
    userId: 'u_abcdef123456',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent granted',
    timestamp: '2026-08-22T10:00:00.000Z',
    transformations: [{ path: 'user_id', action: 'hash', matched: 1 }],
  },
  {
    userId: 'u_zzzzzz999999',
    destination: 'mixpanel',
    decision: 'blocked',
    reason: 'no consent',
    timestamp: '2026-08-22T10:00:01.000Z',
    transformations: [],
  },
  {
    userId: 'u_detected00001',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent granted',
    timestamp: '2026-08-22T10:00:02.000Z',
    transformations: [{ path: 'ep.note', action: 'redact', matched: 2, detector: 'email' }],
  },
]

function stubApi() {
  return vi.fn(async (url: any) => {
    const u = String(url)
    const body = u.includes('/api/stats')
      ? stats
      : u.includes('/api/rules')
        ? rules
        : u.includes('/audit')
          ? logs
          : {}
    return { ok: true, json: async () => body } as unknown as Response
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

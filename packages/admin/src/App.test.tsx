import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import App from './App'

/**
 * Smoke coverage for the dashboard shell: it must mount, survive the initial
 * data fetch, and render what the proxy reports. The API layer is stubbed at
 * the fetch boundary so no server is required.
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
    timestamp: 1_700_000_000_000,
  },
  {
    userId: 'u_zzzzzz999999',
    destination: 'mixpanel',
    decision: 'blocked',
    reason: 'no consent',
    timestamp: 1_700_000_001_000,
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

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  globalThis.fetch = stubApi() as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('App', () => {
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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * The interceptor patches window.fetch, XMLHttpRequest.prototype and
 * navigator.sendBeacon at import time, so every test re-imports the module
 * against freshly stubbed globals and restores them afterwards.
 */

const TRACKER = 'https://www.google-analytics.com/g/collect?v=2'
const NEUTRAL = 'https://api.example.com/orders'

let pristineFetch: typeof window.fetch
let pristineOpen: typeof XMLHttpRequest.prototype.open
let pristineSend: typeof XMLHttpRequest.prototype.send
let pristineBeacon: unknown
let pristineImageSrc: PropertyDescriptor | undefined
let pristineSetAttribute: typeof HTMLImageElement.prototype.setAttribute

/**
 * Boot the interceptor with the given config, as the real bundle does on a
 * fresh page load. init() refuses to patch twice in one window, so the guard is
 * cleared here: a new page load is precisely the case it is not meant to block.
 */
async function loadClient(config: Record<string, unknown> = {}) {
  ;(window as any).__sluiceConfig = { proxyPath: '/analytics', ...config }
  delete (window as any).__sluiceInitialized
  vi.resetModules()
  await import('./index')
}

beforeEach(() => {
  pristineFetch = window.fetch
  pristineOpen = XMLHttpRequest.prototype.open
  pristineSend = XMLHttpRequest.prototype.send
  pristineBeacon = (navigator as any).sendBeacon
  pristineImageSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  pristineSetAttribute = HTMLImageElement.prototype.setAttribute

  document.head.innerHTML = ''
  document.cookie = 'cuid=; Max-Age=0; path=/'
  localStorage.clear()
  delete (window as any).Sluice
  delete (window as any).__sluiceConfig
  // init() is idempotent per window, and jsdom's window outlives resetModules.
  delete (window as any).__sluiceInitialized

  // jsdom implements neither fetch nor sendBeacon; the interceptor wraps whatever it finds.
  window.fetch = vi.fn(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
  Object.defineProperty(navigator, 'sendBeacon', {
    value: vi.fn(() => true),
    configurable: true,
    writable: true,
  })
})

afterEach(() => {
  window.fetch = pristineFetch
  XMLHttpRequest.prototype.open = pristineOpen
  XMLHttpRequest.prototype.send = pristineSend
  Object.defineProperty(navigator, 'sendBeacon', {
    value: pristineBeacon,
    configurable: true,
    writable: true,
  })
  if (pristineImageSrc) Object.defineProperty(HTMLImageElement.prototype, 'src', pristineImageSrc)
  HTMLImageElement.prototype.setAttribute = pristineSetAttribute
})

describe('public API', () => {
  it('exposes userId, proxyBase and setConsent on window.Sluice', async () => {
    await loadClient()
    const sluice = (window as any).Sluice
    expect(sluice).toBeDefined()
    expect(typeof sluice.userId).toBe('string')
    expect(sluice.userId.length).toBeGreaterThan(0)
    expect(sluice.proxyBase).toBe(`${window.location.origin}/analytics`)
    expect(typeof sluice.setConsent).toBe('function')
  })

  it('honours an absolute proxyUrl over proxyPath', async () => {
    await loadClient({ proxyUrl: 'https://proxy.example.com/' })
    expect((window as any).Sluice.proxyBase).toBe('https://proxy.example.com')
  })

  it('reads config from a meta tag', async () => {
    document.head.innerHTML = `<meta name="sluice-config" content='{"proxyPath":"/from-meta"}' />`
    ;(window as any).__sluiceConfig = undefined
    vi.resetModules()
    await import('./index')
    expect((window as any).Sluice.proxyBase).toBe(`${window.location.origin}/from-meta`)
  })

  it('persists the user id in a cookie and reuses it', async () => {
    await loadClient()
    const first = (window as any).Sluice.userId
    expect(document.cookie).toContain(`cuid=${first}`)

    delete (window as any).Sluice
    await loadClient()
    expect((window as any).Sluice.userId).toBe(first)
  })

  it('pins the user id when one is supplied', async () => {
    await loadClient({ userId: 'pinned-user' })
    expect((window as any).Sluice.userId).toBe('pinned-user')
  })
})

describe('fetch interception', () => {
  it('leaves non-tracking requests untouched', async () => {
    // Hold the underlying mock: after init, window.fetch is the patched wrapper.
    const underlying = vi.fn(async () => new Response(null, { status: 204 }))
    window.fetch = underlying as unknown as typeof fetch
    await loadClient()

    await window.fetch(NEUTRAL)
    expect(underlying).toHaveBeenCalledWith(NEUTRAL, undefined)
  })

  it('reroutes a tracking request to the proxy with identity headers', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    window.fetch = vi.fn(async (url: any, init: any) => {
      calls.push([String(url), init])
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch

    await loadClient()
    await window.fetch(TRACKER)

    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]
    expect(url).toBe(`${window.location.origin}/analytics/ingest/ga4`)

    const headers = new Headers(init!.headers)
    expect(headers.get('X-Original-Url')).toBe(TRACKER)
    expect(headers.get('X-Consent-UserId')).toBe((window as any).Sluice.userId)
    expect(init!.credentials).toBe('include')
  })

  it('returns an opaque 204 to the caller when the proxy accepts', async () => {
    window.fetch = vi.fn(async () => new Response('forwarded', { status: 200 })) as any
    await loadClient()

    const res = await window.fetch(TRACKER)
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })

  it('fails closed with an opaque 204 when the proxy is unreachable', async () => {
    window.fetch = vi.fn(async () => {
      throw new Error('connection refused')
    }) as any
    await loadClient()

    const res = await window.fetch(TRACKER)
    expect(res.status).toBe(204)
  })

  it('falls back to the vendor only when dangerouslyAllowOnError is set', async () => {
    const inner = vi.fn(async (url: any) => {
      if (String(url).includes('/ingest/')) throw new Error('connection refused')
      return new Response('vendor', { status: 200 })
    })
    window.fetch = inner as any
    await loadClient({ dangerouslyAllowOnError: true })

    const res = await window.fetch(TRACKER)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('vendor')
  })

  it('stops rerouting for the rest of the session after a 403', async () => {
    const seen: string[] = []
    window.fetch = vi.fn(async (url: any) => {
      seen.push(String(url))
      return new Response(null, { status: 403 })
    }) as any
    await loadClient()

    await window.fetch(TRACKER)
    expect(seen[0]).toContain('/ingest/ga4')

    // Second call must go straight to the vendor rather than the proxy.
    await window.fetch(TRACKER)
    expect(seen[1]).toBe(TRACKER)
  })
})

describe('sendBeacon interception', () => {
  /** Install a fresh beacon mock and return it; init() wraps it in place. */
  function stubBeacon() {
    const underlying = vi.fn((_url: string | URL, _data?: BodyInit | null) => true)
    Object.defineProperty(navigator, 'sendBeacon', {
      value: underlying,
      configurable: true,
      writable: true,
    })
    return underlying
  }

  it('leaves non-tracking beacons untouched', async () => {
    const underlying = stubBeacon()
    await loadClient()

    navigator.sendBeacon(NEUTRAL, 'payload')
    expect(underlying).toHaveBeenCalledWith(NEUTRAL, 'payload')
  })

  it('reroutes tracking beacons with cuid and original url', async () => {
    const underlying = stubBeacon()
    await loadClient()

    navigator.sendBeacon(TRACKER, 'payload')

    const sent = new URL(underlying.mock.calls.at(-1)![0] as string)
    expect(sent.pathname).toBe('/analytics/ingest/ga4')
    expect(sent.searchParams.get('cuid')).toBe((window as any).Sluice.userId)
    expect(sent.searchParams.get('original')).toBe(TRACKER)
  })
})

describe('XMLHttpRequest interception', () => {
  it('rewrites the target url of a tracking request', async () => {
    await loadClient()
    const xhr = new XMLHttpRequest()
    xhr.open('POST', TRACKER)
    expect(xhr._sluiceDestination).toBe('ga4')
    expect(xhr._sluiceOriginalUrl).toBe(TRACKER)
  })

  it('leaves non-tracking requests unmarked', async () => {
    await loadClient()
    const xhr = new XMLHttpRequest()
    xhr.open('GET', NEUTRAL)
    expect(xhr._sluiceDestination).toBeUndefined()
  })
})

describe('script neutralisation', () => {
  it('defuses a dynamically injected tracker script', async () => {
    await loadClient()

    const script = document.createElement('script')
    script.src = 'https://www.google-analytics.com/analytics.js'
    document.body.appendChild(script)

    // MutationObserver callbacks are delivered as microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(script.type).toBe('text/plain')
    expect(script.getAttribute('data-sluice-blocked')).toBe('true')
    expect(script.getAttribute('data-sluice-destination')).toBe('ga4')
  })

  it('leaves unrelated scripts alone', async () => {
    await loadClient()

    const script = document.createElement('script')
    script.src = 'https://cdn.example.com/app.js'
    document.body.appendChild(script)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(script.getAttribute('data-sluice-blocked')).toBeNull()
  })
})

describe('<img> pixel interception', () => {
  const PIXEL = 'https://www.facebook.com/tr/?id=1&ev=Purchase&ud%5Bem%5D=alice%40example.com'

  it('reroutes a tracking image with cuid and original url', async () => {
    await loadClient()
    const img = new Image()
    img.src = PIXEL

    const sent = new URL(img.src)
    expect(sent.pathname).toBe('/analytics/ingest/facebook_pixel')
    expect(sent.searchParams.get('cuid')).toBe((window as any).Sluice.userId)
    expect(sent.searchParams.get('original')).toBe(PIXEL)
  })

  it('leaves a non-tracking image untouched', async () => {
    await loadClient()
    const img = new Image()
    img.src = NEUTRAL
    expect(img.src).toBe(NEUTRAL)
  })

  it('routes setAttribute("src") the same way as the property', async () => {
    await loadClient()
    const img = document.createElement('img')
    img.setAttribute('src', PIXEL)

    const sent = new URL(img.getAttribute('src')!)
    expect(sent.pathname).toBe('/analytics/ingest/facebook_pixel')
    expect(sent.searchParams.get('original')).toBe(PIXEL)
  })

  it('leaves attributes other than src alone', async () => {
    await loadClient()
    const img = document.createElement('img')
    img.setAttribute('alt', PIXEL)
    expect(img.getAttribute('alt')).toBe(PIXEL)
  })
})

describe('idempotency', () => {
  it('does not wrap the patches a second time', async () => {
    await loadClient()
    const patchedFetch = window.fetch
    const patchedOpen = XMLHttpRequest.prototype.open

    const mod = await import('./index')
    mod.init({ proxyPath: '/analytics' })

    expect(window.fetch).toBe(patchedFetch)
    expect(XMLHttpRequest.prototype.open).toBe(patchedOpen)
  })
})

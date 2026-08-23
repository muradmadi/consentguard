/**
 * Sluice Client Interceptor
 *
 * Patches global networking primitives to reroute analytics requests
 * through the Sluice proxy. It holds no secret and grants no consent:
 * consent reaches the firewall from an external CMP over /webhooks/:provider,
 * never from the page that is being measured.
 */

import { INTERCEPTION_PATTERNS, matchDestination } from './patterns'

export interface ClientConfig {
  /** Absolute proxy URL, e.g. https://proxy.example.com. Overrides proxyPath. */
  proxyUrl?: string
  /** Path where the proxy is mounted on the same origin as the app. Default: /analytics. */
  proxyPath?: string
  /** Extra `host[/pathPrefix]` -> destination id entries, merged with the built-in table. */
  destinations?: Record<string, string>
  /** Pin the user id instead of the per-session one. */
  userId?: string
  /** If true, watch for dynamically injected <script> tags and neutralize known trackers. */
  observeMutations?: boolean
  /**
   * If the proxy is unreachable, fall back to sending directly to the vendor.
   * Off by default — fail-closed behavior is safer for a privacy tool.
   */
  dangerouslyAllowOnError?: boolean
}

interface ResolvedConfig extends ClientConfig {
  destinations: Record<string, string>
  observeMutations: boolean
  dangerouslyAllowOnError: boolean
}

/** 1x1 transparent GIF. Assigned instead of a vendor URL when routing fails. */
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const DEFAULTS = {
  destinations: INTERCEPTION_PATTERNS,
  observeMutations: true,
  dangerouslyAllowOnError: false,
}

/** Where the session identifier lives. Cleared by the browser with the tab. */
const SESSION_KEY = 'sluice_session_id'

/** The persistent id earlier versions wrote on page load, removed on sight. */
const LEGACY_PERSISTENT_KEY = 'sluice_user_id'

function getConfigFromMeta(): Partial<ClientConfig> {
  if (typeof document === 'undefined') return {}
  const meta = document.querySelector('meta[name="sluice-config"]')
  if (!meta) return {}
  const content = meta.getAttribute('content')
  if (!content) return {}
  try {
    return JSON.parse(content)
  } catch (e) {
    console.error('[Sluice] Failed to parse config from meta tag:', e)
    return {}
  }
}

function resolveProxyBase(config: ResolvedConfig): string {
  if (config.proxyUrl) {
    return config.proxyUrl.replace(/\/$/, '')
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  let path = config.proxyPath || '/analytics'
  if (!path.startsWith('/')) path = '/' + path
  if (path.endsWith('/')) path = path.slice(0, -1)
  return `${origin}${path}`
}

/**
 * A per-session identifier, and nothing that outlives the session.
 *
 * This used to write a 365-day cookie and a `localStorage` entry on page load,
 * before any consent record existed — storing a persistent tracking identifier
 * without consent, which is an ePrivacy Art. 5(3) problem in a tool whose whole
 * point is compliance, and which the `localStorage` copy made survive the user
 * deleting their cookies. It was also fiction on Safari, where a cookie set from
 * `document.cookie` is capped at seven days whatever expiry it names.
 *
 * The identifier now lives in `sessionStorage` and dies with the tab. Making it
 * persistent is the server's decision and only after a consent record exists:
 * it answers with a first-party `Set-Cookie`, which the browser then sends on
 * every proxied request ahead of anything the page says about itself.
 */
function getSessionUserId(config: ResolvedConfig): string {
  if (config.userId) return config.userId
  if (typeof window === 'undefined') return 'server'

  forgetLegacyPersistentId()

  const existing = readSession()
  if (existing) return existing

  const id =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : 'u_' + Math.random().toString(36).substring(2, 15)

  writeSession(id)
  return id
}

/**
 * Storage access throws outright when a browser is set to block site data, so
 * every read and write here is guarded. A visitor who blocks storage gets a new
 * identifier per page and no complaint, which is the correct outcome.
 */
function readSession(): string | null {
  try {
    return sessionStorage.getItem(SESSION_KEY)
  } catch {
    return null
  }
}

function writeSession(id: string): void {
  try {
    sessionStorage.setItem(SESSION_KEY, id)
  } catch {
    // Nothing to do: the id is still used for this page load.
  }
}

/** An identifier stored without consent is not one to keep once we know better. */
function forgetLegacyPersistentId(): void {
  try {
    localStorage.removeItem(LEGACY_PERSISTENT_KEY)
  } catch {
    // Blocked storage holds nothing to remove.
  }
}

export function init(config?: Partial<ClientConfig>) {
  if (typeof window === 'undefined') return

  // Patching is not idempotent: a second call would wrap our own wrappers, so
  // every request would be counted and rerouted twice. A page can easily load
  // the bundle more than once.
  if (window.__sluiceInitialized) return
  window.__sluiceInitialized = true

  const resolved: ResolvedConfig = { ...DEFAULTS, ...config } as ResolvedConfig
  // There used to be a `domains` option here that mapped an arbitrary host to
  // the destination id `unknown`. No rule describes that id, so every request
  // it produced was refused at /ingest and discarded by the caller below — a
  // documented option whose only effect was to drop the traffic it was asked to
  // protect. Extending coverage means a destination rule, which is what
  // `destinations` is for; blocking a host by name is not something this
  // firewall claims to do.
  const activeDestinations = { ...resolved.destinations }

  const userId = getSessionUserId(resolved)
  const proxyBase = resolveProxyBase(resolved)
  const ingestBase = `${proxyBase}/ingest`

  // Expose the resolved identity for debugging. This is the session id the
  // page minted; once consent has promoted one, the server's HttpOnly cookie
  // outranks it and the page cannot read that. No secrets, and nothing
  // writable: a page cannot assert its own consent.
  ;(window as any).Sluice = { userId, proxyBase }

  // If proxy returns 403, stop rerouting for the remainder of the session
  // rather than hammering it. Reset on next full page load.
  let stopRerouting = false

  const proxyUrlFor = (dest: string) => `${ingestBase}/${dest}`

  /**
   * Rewrite a vendor URL to the proxy for transports that cannot carry request
   * headers — a beacon or an image. Identity and the URL the SDK targeted ride
   * in the query string instead, which is what /ingest falls back to when the
   * X-Consent-UserId and X-Original-Url headers are absent.
   *
   * Returns null when the URL is not tracking traffic, so callers can pass it
   * through untouched.
   */
  const rewriteTrackingUrl = (url: string): string | null => {
    const destination = !stopRerouting ? matchDestination(url, activeDestinations) : null
    if (!destination) return null
    const proxied = new URL(proxyUrlFor(destination))
    proxied.searchParams.set('cuid', userId)
    proxied.searchParams.set('original', url)
    return proxied.toString()
  }

  // Started only now, because it hands the observer `rewriteTrackingUrl`.
  if (resolved.observeMutations) {
    observeMutations({
      getDestination: (url) => matchDestination(url, activeDestinations),
      rewriteTrackingUrl,
    })
  }

  // --- fetch ---
  const originalFetch = window.fetch
  window.fetch = async (input: RequestInfo | URL, initOpts?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const destination = !stopRerouting ? matchDestination(url, activeDestinations) : null

    if (!destination) {
      return originalFetch(input, initOpts)
    }

    const headers = new Headers(initOpts?.headers)
    headers.set('X-Consent-UserId', userId)
    headers.set('X-Original-Url', url)

    try {
      const res = await originalFetch(proxyUrlFor(destination), {
        ...initOpts,
        credentials: 'include',
        headers,
      })

      if (res.status === 403) {
        stopRerouting = true
        return fallbackOrOpaque(
          originalFetch,
          input,
          initOpts,
          resolved.dangerouslyAllowOnError,
          url,
        )
      }

      // Rule: return an opaque 204 back to the calling SDK so it thinks the
      // request succeeded regardless of whether the proxy forwarded, scrubbed,
      // or dropped it. Keeps vendor SDKs from retrying.
      if (res.ok || res.status === 204) {
        return new Response(null, { status: 204, statusText: 'No Content' })
      }

      return fallbackOrOpaque(originalFetch, input, initOpts, resolved.dangerouslyAllowOnError, url)
    } catch (err) {
      console.error('[Sluice] Proxy unreachable:', err)
      return fallbackOrOpaque(originalFetch, input, initOpts, resolved.dangerouslyAllowOnError, url)
    }
  }

  // --- XMLHttpRequest ---
  const XHR = XMLHttpRequest.prototype
  const originalOpen = XHR.open
  const originalSend = XHR.send

  XHR.open = function (method: string, url: string | URL, ...rest: any[]) {
    const urlStr = url.toString()
    const destination = !stopRerouting ? matchDestination(urlStr, activeDestinations) : null
    if (destination) {
      this._sluiceDestination = destination
      this._sluiceOriginalUrl = urlStr
      return originalOpen.apply(this, [method, proxyUrlFor(destination), ...rest] as any)
    }
    return originalOpen.apply(this, [method, url, ...rest] as any)
  }

  XHR.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    if (!this._sluiceDestination) {
      return originalSend.apply(this, [body])
    }

    try {
      this.setRequestHeader('X-Consent-UserId', userId)
      if (this._sluiceOriginalUrl) this.setRequestHeader('X-Original-Url', this._sluiceOriginalUrl)

      const shim = () => {
        if (this.readyState !== 4) return
        if (this.status === 403) stopRerouting = true
        // Present an opaque success to the vendor SDK regardless of actual outcome.
        if (this.status === 200 || this.status === 204) {
          Object.defineProperty(this, 'status', { get: () => 204, configurable: true })
          Object.defineProperty(this, 'statusText', { get: () => 'No Content', configurable: true })
          Object.defineProperty(this, 'response', { get: () => '', configurable: true })
          Object.defineProperty(this, 'responseText', { get: () => '', configurable: true })
        }
      }
      this.addEventListener('readystatechange', shim)
    } catch (err) {
      console.error('[Sluice] Error patching XHR headers:', err)
    }

    try {
      return originalSend.apply(this, [body])
    } catch (err) {
      console.error('[Sluice] XHR send error:', err)
      setTimeout(() => {
        Object.defineProperty(this, 'readyState', { get: () => 4, configurable: true })
        Object.defineProperty(this, 'status', { get: () => 204, configurable: true })
        if (this.onload) (this.onload as any)()
        if (this.onreadystatechange) (this.onreadystatechange as any)()
      }, 0)
    }
  }

  // --- navigator.sendBeacon ---
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator)
    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null) {
      const urlStr = url.toString()
      try {
        const proxied = rewriteTrackingUrl(urlStr)
        if (!proxied) return originalSendBeacon(url, data)
        return originalSendBeacon(proxied, data)
      } catch (err) {
        console.error('[Sluice] Beacon routing error:', err)
        return resolved.dangerouslyAllowOnError ? originalSendBeacon(url, data) : true
      }
    }
  }

  // --- <img> pixels ---
  // The Meta pixel and much of ad-tech send events by assigning an image's src.
  // None of fetch, XHR or sendBeacon sees those, so without this the request
  // walks straight past the firewall. Both ways a src can be set are covered,
  // and srcset alongside it: a candidate list is a list of URLs the browser
  // will fetch one of, which makes it as usable a beacon as src.
  //
  // One limit remains, and it is not closable here. An <img> written into the
  // initial HTML above the Sluice tag has its src set by the parser before this
  // code exists — the same root cause as a tracker that captures window.fetch
  // first. The mutation observer catches what the parser appends after us; what
  // it cannot catch is an install requirement, not a bug. See docs/install.md.
  if (typeof HTMLImageElement !== 'undefined') {
    const rewriteSrc = (value: string): string => {
      try {
        return rewriteTrackingUrl(value) ?? value
      } catch (err) {
        console.error('[Sluice] Image routing error:', err)
        // Fail closed: a transparent pixel issues no request at all, where an
        // empty src would re-request the current page.
        return resolved.dangerouslyAllowOnError ? value : TRANSPARENT_PIXEL
      }
    }

    patchImageUrlProperty('src', rewriteSrc)
    patchImageUrlProperty('srcset', (value) => rewriteSrcset(value, rewriteSrc))

    // setAttribute lives on Element.prototype; assigning here shadows it for
    // images only, leaving every other element's attributes alone.
    const originalSetAttribute = HTMLImageElement.prototype.setAttribute
    HTMLImageElement.prototype.setAttribute = function (name: string, value: string) {
      const attribute = name.toLowerCase()
      if (attribute === 'src') {
        return originalSetAttribute.call(this, name, rewriteSrc(String(value)))
      }
      if (attribute === 'srcset') {
        return originalSetAttribute.call(this, name, rewriteSrcset(String(value), rewriteSrc))
      }
      return originalSetAttribute.call(this, name, value)
    }
  }
}

/** Wrap one of HTMLImageElement's URL-bearing properties, leaving its getter alone. */
function patchImageUrlProperty(name: 'src' | 'srcset', rewrite: (value: string) => string) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, name)
  if (!descriptor?.set) return
  const originalSetter = descriptor.set
  Object.defineProperty(HTMLImageElement.prototype, name, {
    ...descriptor,
    set(value: string) {
      originalSetter.call(this, rewrite(String(value)))
    },
  })
}

/**
 * Rewrite each URL in a srcset candidate list, keeping its descriptor.
 *
 * A candidate is `url` optionally followed by a width or density descriptor,
 * and the list is comma-separated. A URL cannot contain an unescaped comma or
 * whitespace, so splitting on those is the parse the HTML spec describes.
 */
function rewriteSrcset(value: string, rewrite: (url: string) => string): string {
  return value
    .split(',')
    .map((candidate) => {
      const match = candidate.match(/^(\s*)(\S+)(\s*.*)$/)
      if (!match) return candidate
      const [, leading, url, descriptor] = match
      return `${leading}${rewrite(url)}${descriptor}`
    })
    .join(',')
}

function fallbackOrOpaque(
  originalFetch: typeof fetch,
  input: RequestInfo | URL,
  initOpts: RequestInit | undefined,
  allowFallback: boolean,
  _originalUrl: string,
): Promise<Response> | Response {
  if (allowFallback) return originalFetch(input, initOpts)
  return new Response(null, { status: 204, statusText: 'No Content' })
}

interface ObserverHooks {
  getDestination: (url: string) => string | null
  rewriteTrackingUrl: (url: string) => string | null
}

/**
 * Watch the DOM for trackers the patched primitives never see.
 *
 * A `<script>` gets defused. An `<img>` gets its `src` rewritten to the proxy,
 * which is the only chance to catch a pixel the parser built rather than script
 * — the `HTMLImageElement.prototype.src` setter is never called for one, so
 * without this it walks straight past the firewall.
 *
 * It is a chance and not a guarantee. The observer is delivered a microtask
 * after the node is appended, and the browser may already have started the
 * request; re-assigning `src` aborts an in-flight image load in every engine,
 * but a request already on the wire has already carried the query string.
 * There is deliberately no document-ready sweep behind this: by then every one
 * of those requests has completed, so a sweep could not prevent a leak and
 * would only send the vendor the same event a second time. A pixel that has to
 * be caught reliably has to be below the Sluice tag — see docs/install.md.
 */
function observeMutations({ getDestination, rewriteTrackingUrl }: ObserverHooks) {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeName === 'SCRIPT') {
          const script = node as HTMLScriptElement
          if (!script.src) return
          const destination = getDestination(script.src)
          if (!destination) return
          script.type = 'text/plain'
          script.setAttribute('data-sluice-blocked', 'true')
          script.setAttribute('data-sluice-destination', destination)
          return
        }

        if (node.nodeName === 'IMG') {
          const img = node as HTMLImageElement
          // Assigning src re-enters the patched setter, which would rewrite an
          // already-proxied URL a second time. The marker makes this once-only.
          if (img.getAttribute('data-sluice-rerouted')) return
          const original = img.getAttribute('src')
          if (!original) return
          const proxied = rewriteTrackingUrl(original)
          if (!proxied) return
          img.setAttribute('data-sluice-rerouted', 'true')
          img.src = proxied
        }
      })
    })
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

declare global {
  interface XMLHttpRequest {
    _sluiceDestination?: string
    _sluiceOriginalUrl?: string
  }
  interface Window {
    Sluice?: {
      userId: string
      proxyBase: string
    }
    __sluiceConfig?: Partial<ClientConfig>
    /** Set by init() so a second load cannot wrap the patches a second time. */
    __sluiceInitialized?: boolean
  }
}

// Auto-init when loaded as a bundle in the browser.
if (typeof window !== 'undefined') {
  const metaConfig = getConfigFromMeta()
  const windowConfig = window.__sluiceConfig || {}
  init({ ...metaConfig, ...windowConfig })
}

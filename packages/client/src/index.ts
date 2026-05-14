/**
 * ConsentGuard Client Interceptor
 * 
 * Patches global networking primitives to reroute analytics requests
 * through the ConsentGuard proxy.
 */

console.log('[ConsentGuard] Library loaded');

export interface ClientConfig {
  proxyUrl: string
  destinations: Record<string, string>
  userId?: string
}

const DEFAULT_CONFIG: ClientConfig = {
  proxyUrl: 'http://localhost:3000/ingest',
  destinations: {
    'google-analytics.com': 'ga4',
    'api.mixpanel.com': 'mixpanel',
    'segment.io': 'segment',
  }
}

export function init(config?: Partial<ClientConfig>) {
  if (typeof window === 'undefined') return

  const mergedConfig: ClientConfig = {
    ...DEFAULT_CONFIG,
    ...config,
  }

  // Identify or create a persistent User ID
  const userId = mergedConfig.userId || getOrSetUserId()

  console.log('[ConsentGuard] Initialized with User ID:', userId)

  /**
   * Helper to determine if a URL should be intercepted
   */
  function getDestination(url: string): string | null {
    for (const [domain, id] of Object.entries(mergedConfig.destinations)) {
      if (url.includes(domain)) return id
    }
    return null
  }

  /**
   * Helper to rewrite the request to the proxy
   */
  function getProxyUrl(destination: string): string {
    return `${mergedConfig.proxyUrl}/${destination}`
  }

  // 1. Patch Fetch
  const originalFetch = window.fetch
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const destination = getDestination(url)

    if (destination) {
      console.log(`[ConsentGuard] Intercepting Fetch: ${url} -> ${destination}`)
      const proxyUrl = getProxyUrl(destination)
      
      const headers = new Headers(init?.headers)
      headers.set('X-Consent-UserId', userId)
      headers.set('X-Original-Url', url)

      return originalFetch(proxyUrl, {
        ...init,
        headers,
      })
    }

    return originalFetch(input, init)
  }

  // 2. Patch XMLHttpRequest
  const XHR = XMLHttpRequest.prototype
  const originalOpen = XHR.open
  const originalSend = XHR.send

  XHR.open = function(method: string, url: string | URL, ...args: any[]) {
    const urlStr = url.toString()
    const destination = getDestination(urlStr)
    
    if (destination) {
      this._cgDestination = destination
      this._cgOriginalUrl = urlStr
      const proxyUrl = getProxyUrl(destination)
      console.log(`[ConsentGuard] Intercepting XHR: ${urlStr} -> ${destination}`)
      return originalOpen.apply(this, [method, proxyUrl, ...args] as any)
    }
    
    return originalOpen.apply(this, [method, url, ...args] as any)
  }

  XHR.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    if (this._cgDestination) {
      this.setRequestHeader('X-Consent-UserId', userId)
      this.setRequestHeader('X-Original-Url', this._cgOriginalUrl)
    }
    return originalSend.apply(this, [body])
  }

  // 3. Patch Navigator.sendBeacon
  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon
    navigator.sendBeacon = function(url: string | URL, data?: BodyInit | null) {
      const urlStr = url.toString()
      const destination = getDestination(urlStr)

      if (destination) {
        console.log(`[ConsentGuard] Intercepting Beacon: ${urlStr} -> ${destination}`)
        const proxyUrl = getProxyUrl(destination)
        
        // sendBeacon doesn't support custom headers easily without Blob/FormData
        // For now, we append the userId to the query string if possible, or just send to proxy
        const finalUrl = new URL(proxyUrl)
        finalUrl.searchParams.set('cuid', userId)
        
        return originalSendBeacon.call(navigator, finalUrl.toString(), data)
      }

      return originalSendBeacon.call(navigator, url, data)
    }
  }
}

/**
 * Utility to persist/retrieve ConsentGuard User ID
 */
function getOrSetUserId(): string {
  const KEY = 'cg_user_id'
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = 'u_' + Math.random().toString(36).substring(2, 11)
    localStorage.setItem(KEY, id)
  }
  return id
}

// Support for TypeScript augmentation of XHR
declare global {
  interface XMLHttpRequest {
    _cgDestination?: string
    _cgOriginalUrl?: string
  }
}

// Auto-init
if (typeof window !== 'undefined') {
  const config = (window as any).__consentGuardConfig
  init(config)
}


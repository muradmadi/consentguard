/**
 * Sluice Client Interceptor
 *
 * Patches global networking primitives to reroute analytics requests
 * through the Sluice proxy. Exposes window.Sluice.setConsent()
 * so your consent banner can grant/revoke purposes without embedding
 * any server secret in the browser bundle.
 */

import { INTERCEPTION_PATTERNS } from './patterns';

export interface ClientConfig {
  /** Absolute proxy URL, e.g. https://proxy.example.com. Overrides proxyPath. */
  proxyUrl?: string;
  /** Path where the proxy is mounted on the same origin as the app. Default: /analytics. */
  proxyPath?: string;
  /** Map of domain substring -> destination id. Merged with the built-in registry. */
  destinations?: Record<string, string>;
  /** Extra domains to treat as tracking; matched requests are proxied under destination "unknown". */
  domains?: string[];
  /** Pin the user id instead of the persistent cuid cookie. */
  userId?: string;
  /** If true, watch for dynamically injected <script> tags and neutralize known trackers. */
  observeMutations?: boolean;
  /**
   * If the proxy is unreachable, fall back to sending directly to the vendor.
   * Off by default — fail-closed behavior is safer for a privacy tool.
   */
  dangerouslyAllowOnError?: boolean;
  /** Cookie name storing the persistent user id. Default: cuid. */
  cookieName?: string;
}

interface ResolvedConfig extends ClientConfig {
  destinations: Record<string, string>;
  observeMutations: boolean;
  dangerouslyAllowOnError: boolean;
  cookieName: string;
}

const DEFAULTS = {
  destinations: INTERCEPTION_PATTERNS,
  observeMutations: true,
  dangerouslyAllowOnError: false,
  cookieName: 'cuid',
};

function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

function setCookie(name: string, value: string, days = 365) {
  if (typeof document === 'undefined') return;
  const date = new Date();
  date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${date.toUTCString()}; SameSite=Lax`;
}

function getConfigFromMeta(): Partial<ClientConfig> {
  if (typeof document === 'undefined') return {};
  const meta = document.querySelector('meta[name="sluice-config"]');
  if (!meta) return {};
  const content = meta.getAttribute('content');
  if (!content) return {};
  try {
    return JSON.parse(content);
  } catch (e) {
    console.error('[Sluice] Failed to parse config from meta tag:', e);
    return {};
  }
}

function resolveProxyBase(config: ResolvedConfig): string {
  if (config.proxyUrl) {
    return config.proxyUrl.replace(/\/$/, '');
  }
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  let path = config.proxyPath || '/analytics';
  if (!path.startsWith('/')) path = '/' + path;
  if (path.endsWith('/')) path = path.slice(0, -1);
  return `${origin}${path}`;
}

function getOrSetUserId(config: ResolvedConfig): string {
  if (config.userId) return config.userId;
  if (typeof window === 'undefined') return 'server';

  const cookieName = config.cookieName;
  const existing = getCookie(cookieName);
  if (existing) return existing;

  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('sluice_user_id') : null;
  if (stored) {
    setCookie(cookieName, stored);
    return stored;
  }

  const id = typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : 'u_' + Math.random().toString(36).substring(2, 15);

  setCookie(cookieName, id);
  if (typeof localStorage !== 'undefined') localStorage.setItem('sluice_user_id', id);
  return id;
}

/**
 * Publicly-callable consent API. Wire this up to your banner's Accept/Reject buttons.
 * Purposes shape: { analytics: true, marketing: false, ... }. `necessary` is always true.
 */
async function setConsent(
  purposes: Record<string, boolean>,
  proxyBase: string,
  userId: string,
): Promise<{ ok: boolean; replayed?: number; error?: string }> {
  try {
    const res = await fetch(`${proxyBase}/consent/self`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': userId },
      body: JSON.stringify({
        purposes: { necessary: true, ...purposes },
        timestamp: Date.now(),
        metadata: { source: 'client' },
      }),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const data = (await res.json().catch(() => ({}))) as { replayed?: number };
    return { ok: true, replayed: data.replayed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'network error' };
  }
}

export function init(config?: Partial<ClientConfig>) {
  if (typeof window === 'undefined') return;

  const resolved: ResolvedConfig = { ...DEFAULTS, ...config } as ResolvedConfig;
  const activeDestinations = { ...resolved.destinations };
  if (resolved.domains) {
    resolved.domains.forEach((d) => {
      activeDestinations[d] = activeDestinations[d] || 'unknown';
    });
  }

  const userId = getOrSetUserId(resolved);
  const proxyBase = resolveProxyBase(resolved);
  const ingestBase = `${proxyBase}/ingest`;

  // Expose the public API. No secrets involved.
  (window as any).Sluice = {
    userId,
    proxyBase,
    setConsent: (purposes: Record<string, boolean>) => setConsent(purposes, proxyBase, userId),
  };

  if (resolved.observeMutations) {
    observeMutations((url) => matchDestination(url, activeDestinations));
  }

  // If proxy returns 403, stop rerouting for the remainder of the session
  // rather than hammering it. Reset on next full page load.
  let stopRerouting = false;

  const proxyUrlFor = (dest: string) => `${ingestBase}/${dest}`;

  // --- fetch ---
  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, initOpts?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const destination = !stopRerouting ? matchDestination(url, activeDestinations) : null;

    if (!destination) {
      return originalFetch(input, initOpts);
    }

    const headers = new Headers(initOpts?.headers);
    headers.set('X-Consent-UserId', userId);
    headers.set('X-Original-Url', url);

    try {
      const res = await originalFetch(proxyUrlFor(destination), {
        ...initOpts,
        credentials: 'include',
        headers,
      });

      if (res.status === 403) {
        stopRerouting = true;
        return fallbackOrOpaque(originalFetch, input, initOpts, resolved.dangerouslyAllowOnError, url);
      }

      // Rule: return an opaque 204 back to the calling SDK so it thinks the
      // request succeeded regardless of whether the proxy forwarded, scrubbed,
      // or dropped it. Keeps vendor SDKs from retrying.
      if (res.ok || res.status === 202 || res.status === 204) {
        return new Response(null, { status: 204, statusText: 'No Content' });
      }

      return fallbackOrOpaque(originalFetch, input, initOpts, resolved.dangerouslyAllowOnError, url);
    } catch (err) {
      console.error('[Sluice] Proxy unreachable:', err);
      return fallbackOrOpaque(originalFetch, input, initOpts, resolved.dangerouslyAllowOnError, url);
    }
  };

  // --- XMLHttpRequest ---
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  XHR.open = function (method: string, url: string | URL, ...rest: any[]) {
    const urlStr = url.toString();
    const destination = !stopRerouting ? matchDestination(urlStr, activeDestinations) : null;
    if (destination) {
      this._sluiceDestination = destination;
      this._sluiceOriginalUrl = urlStr;
      return originalOpen.apply(this, [method, proxyUrlFor(destination), ...rest] as any);
    }
    return originalOpen.apply(this, [method, url, ...rest] as any);
  };

  XHR.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    if (!this._sluiceDestination) {
      return originalSend.apply(this, [body]);
    }

    try {
      this.setRequestHeader('X-Consent-UserId', userId);
      if (this._sluiceOriginalUrl) this.setRequestHeader('X-Original-Url', this._sluiceOriginalUrl);

      const shim = () => {
        if (this.readyState !== 4) return;
        if (this.status === 403) stopRerouting = true;
        // Present an opaque success to the vendor SDK regardless of actual outcome.
        if (this.status === 200 || this.status === 202 || this.status === 204) {
          Object.defineProperty(this, 'status', { get: () => 204, configurable: true });
          Object.defineProperty(this, 'statusText', { get: () => 'No Content', configurable: true });
          Object.defineProperty(this, 'response', { get: () => '', configurable: true });
          Object.defineProperty(this, 'responseText', { get: () => '', configurable: true });
        }
      };
      this.addEventListener('readystatechange', shim);
    } catch (err) {
      console.error('[Sluice] Error patching XHR headers:', err);
    }

    try {
      return originalSend.apply(this, [body]);
    } catch (err) {
      console.error('[Sluice] XHR send error:', err);
      setTimeout(() => {
        Object.defineProperty(this, 'readyState', { get: () => 4, configurable: true });
        Object.defineProperty(this, 'status', { get: () => 204, configurable: true });
        if (this.onload) (this.onload as any)();
        if (this.onreadystatechange) (this.onreadystatechange as any)();
      }, 0);
    }
  };

  // --- navigator.sendBeacon ---
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null) {
      const urlStr = url.toString();
      const destination = !stopRerouting ? matchDestination(urlStr, activeDestinations) : null;
      if (!destination) return originalSendBeacon(url, data);
      try {
        const finalUrl = new URL(proxyUrlFor(destination));
        finalUrl.searchParams.set('cuid', userId);
        finalUrl.searchParams.set('original', urlStr);
        return originalSendBeacon(finalUrl.toString(), data);
      } catch (err) {
        console.error('[Sluice] Beacon routing error:', err);
        return resolved.dangerouslyAllowOnError ? originalSendBeacon(url, data) : true;
      }
    };
  }
}

function matchDestination(url: string, destinations: Record<string, string>): string | null {
  for (const [domain, id] of Object.entries(destinations)) {
    if (url.includes(domain)) return id;
  }
  return null;
}

function fallbackOrOpaque(
  originalFetch: typeof fetch,
  input: RequestInfo | URL,
  initOpts: RequestInit | undefined,
  allowFallback: boolean,
  _originalUrl: string,
): Promise<Response> | Response {
  if (allowFallback) return originalFetch(input, initOpts);
  return new Response(null, { status: 204, statusText: 'No Content' });
}

function observeMutations(getDestination: (url: string) => string | null) {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((m) => {
      m.addedNodes.forEach((node) => {
        if (node.nodeName !== 'SCRIPT') return;
        const script = node as HTMLScriptElement;
        if (!script.src) return;
        const destination = getDestination(script.src);
        if (!destination) return;
        script.type = 'text/plain';
        script.setAttribute('data-sluice-blocked', 'true');
        script.setAttribute('data-sluice-destination', destination);
      });
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}

declare global {
  interface XMLHttpRequest {
    _sluiceDestination?: string;
    _sluiceOriginalUrl?: string;
  }
  interface Window {
    Sluice?: {
      userId: string;
      proxyBase: string;
      setConsent: (purposes: Record<string, boolean>) => Promise<{ ok: boolean; replayed?: number; error?: string }>;
    };
    __sluiceConfig?: Partial<ClientConfig>;
  }
}

// Auto-init when loaded as a bundle in the browser.
if (typeof window !== 'undefined') {
  const metaConfig = getConfigFromMeta();
  const windowConfig = window.__sluiceConfig || {};
  init({ ...metaConfig, ...windowConfig });
}

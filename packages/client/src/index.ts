/**
 * ConsentGuard Client Interceptor
 * 
 * Patches global networking primitives to reroute analytics requests
 * through the ConsentGuard proxy.
 */

console.log('[ConsentGuard] Library loaded');

import { INTERCEPTION_PATTERNS } from './patterns';

export interface ClientConfig {
  proxyUrl?: string;
  proxyPath?: string;
  destinations?: Record<string, string>;
  domains?: string[];
  userId?: string;
  apiKey?: string;
  observeMutations?: boolean;
  dangerouslyAllowOnError?: boolean;
  cookieName?: string;
}

const DEFAULT_CONFIG: Required<Pick<ClientConfig, 'destinations' | 'observeMutations' | 'dangerouslyAllowOnError' | 'cookieName'>> = {
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
  const meta = document.querySelector('meta[name="consentguard-config"]');
  if (meta) {
    const content = meta.getAttribute('content');
    if (content) {
      try {
        return JSON.parse(content);
      } catch (e) {
        console.error('[ConsentGuard] Failed to parse config from meta tag:', e);
      }
    }
  }
  return {};
}

export function init(config?: Partial<ClientConfig>) {
  if (typeof window === 'undefined') return;

  const mergedConfig: ClientConfig & typeof DEFAULT_CONFIG = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  // Support custom domains array in config, mapping them to 'unknown' destination
  const activeDestinations = { ...mergedConfig.destinations };
  if (mergedConfig.domains && Array.isArray(mergedConfig.domains)) {
    mergedConfig.domains.forEach(domain => {
      activeDestinations[domain] = activeDestinations[domain] || 'unknown';
    });
  }

  // Identify or create a persistent User ID
  const userId = mergedConfig.userId || getOrSetUserId(mergedConfig);

  console.log('[ConsentGuard] Initialized with User ID:', userId);

  // Compute Proxy Base URL
  let baseProxyUrl = mergedConfig.proxyUrl;
  if (!baseProxyUrl) {
    const origin = window.location.origin;
    let path = mergedConfig.proxyPath || '/analytics';
    if (!path.startsWith('/')) path = '/' + path;
    if (path.endsWith('/')) path = path.slice(0, -1);
    baseProxyUrl = `${origin}${path}/ingest`;
  } else {
    if (baseProxyUrl.endsWith('/')) baseProxyUrl = baseProxyUrl.slice(0, -1);
  }

  // Handle URL-based consent granting (useful for testing/debugging)
  const consentAdminUrl = baseProxyUrl.replace('/ingest', '');
  handleUrlConsent(userId, consentAdminUrl);

  if (mergedConfig.observeMutations) {
    observeMutations();
  }

  // Session-based rerouting control flag
  let stopRerouting = false;

  /**
   * Helper to determine if a URL should be intercepted
   */
  function getDestination(url: string): string | null {
    for (const [domain, id] of Object.entries(activeDestinations)) {
      if (url.includes(domain)) return id;
    }
    return null;
  }

  /**
   * Helper to rewrite the request to the proxy
   */
  function getProxyUrl(destination: string): string {
    return `${baseProxyUrl}/${destination}`;
  }

  // 1. Patch Fetch
  const originalFetch = window.fetch;
  window.fetch = async (input: RequestInfo | URL, initOpts?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const destination = !stopRerouting ? getDestination(url) : null;

    if (destination) {
      console.log(`[ConsentGuard] Intercepting Fetch: ${url} -> ${destination}`);
      const proxyUrl = getProxyUrl(destination);
      
      const headers = new Headers(initOpts?.headers);
      headers.set('X-Consent-UserId', userId);
      headers.set('X-Original-Url', url);
      
      if (mergedConfig.apiKey) {
        headers.set('Authorization', `Bearer ${mergedConfig.apiKey}`);
      }

      try {
        const res = await originalFetch(proxyUrl, {
          ...initOpts,
          headers,
        });

        if (res.status === 403) {
          console.warn(`[ConsentGuard] Proxy returned 403 Forbidden. Stopping rerouting for this session.`);
          stopRerouting = true;
          if (mergedConfig.dangerouslyAllowOnError) {
            console.log(`[ConsentGuard] Falling back to direct routing for: ${url}`);
            return originalFetch(input, initOpts);
          } else {
            console.warn(`[ConsentGuard] Blocking request (dangerouslyAllowOnError = false): ${url}`);
            return new Response(null, { status: 204, statusText: 'No Content' });
          }
        }

        // Rule 8: OPAQUE CLIENT RESPONSES. Return a clean 204 No Content back to the calling SDK.
        if (res.ok) {
          return new Response(null, { status: 204, statusText: 'No Content' });
        }

        // Other non-2xx status codes
        if (mergedConfig.dangerouslyAllowOnError) {
          console.warn(`[ConsentGuard] Proxy returned status ${res.status}. Falling back to direct routing.`);
          return originalFetch(input, initOpts);
        } else {
          console.warn(`[ConsentGuard] Proxy returned status ${res.status}. Blocking request (dangerouslyAllowOnError = false).`);
          return new Response(null, { status: 204, statusText: 'No Content' });
        }
      } catch (err) {
        console.error('[ConsentGuard] Proxy is unreachable:', err);
        if (mergedConfig.dangerouslyAllowOnError) {
          console.log(`[ConsentGuard] Falling back to direct routing for: ${url}`);
          return originalFetch(input, initOpts);
        } else {
          console.warn(`[ConsentGuard] Proxy unreachable. Blocking request (dangerouslyAllowOnError = false): ${url}`);
          return new Response(null, { status: 204, statusText: 'No Content' });
        }
      }
    }

    return originalFetch(input, initOpts);
  };

  // 2. Patch XMLHttpRequest
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  XHR.open = function(method: string, url: string | URL, ...args: any[]) {
    const urlStr = url.toString();
    const destination = !stopRerouting ? getDestination(urlStr) : null;
    
    if (destination) {
      this._cgDestination = destination;
      this._cgOriginalUrl = urlStr;
      const proxyUrl = getProxyUrl(destination);
      console.log(`[ConsentGuard] Intercepting XHR: ${urlStr} -> ${destination}`);
      return originalOpen.apply(this, [method, proxyUrl, ...args] as any);
    }
    
    return originalOpen.apply(this, [method, url, ...args] as any);
  };

  XHR.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    if (this._cgDestination) {
      try {
        this.setRequestHeader('X-Consent-UserId', userId);
        this.setRequestHeader('X-Original-Url', this._cgOriginalUrl || '');
        
        if (mergedConfig.apiKey) {
          this.setRequestHeader('Authorization', `Bearer ${mergedConfig.apiKey}`);
        }

        const self = this;
        const originalOnReadyStateChange = this.onreadystatechange;
        
        const handleResponse = () => {
          if (self.readyState === 4) {
            if (self.status === 403) {
              console.warn(`[ConsentGuard] Proxy returned 403 for XHR. Stopping rerouting for this session.`);
              stopRerouting = true;
            }
            
            // To ensure the analytics SDK sees a successful 204 response and no leak:
            if (self.status === 200 || self.status === 204 || self.status === 202) {
              Object.defineProperty(self, 'status', { get: () => 204 });
              Object.defineProperty(self, 'statusText', { get: () => 'No Content' });
              Object.defineProperty(self, 'response', { get: () => '' });
              Object.defineProperty(self, 'responseText', { get: () => '' });
            }
          }
        };

        if (this.addEventListener) {
          this.addEventListener('readystatechange', handleResponse);
        } else {
          this.onreadystatechange = function(...args: any[]) {
            handleResponse();
            if (originalOnReadyStateChange) {
              originalOnReadyStateChange.apply(this, args as any);
            }
          };
        }
      } catch (err) {
        console.error('[ConsentGuard] Error in XHR patching headers:', err);
      }
    }
    
    try {
      return originalSend.apply(this, [body]);
    } catch (err) {
      console.error('[ConsentGuard] XHR send error:', err);
      if (this._cgDestination) {
        const self = this;
        setTimeout(() => {
          Object.defineProperty(self, 'readyState', { get: () => 4 });
          Object.defineProperty(self, 'status', { get: () => 204 });
          Object.defineProperty(self, 'statusText', { get: () => 'No Content' });
          if (self.onload) (self.onload as any)();
          if (self.onreadystatechange) (self.onreadystatechange as any)();
        }, 0);
      } else {
        throw err;
      }
    }
  };

  // 3. Patch Navigator.sendBeacon
  if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url: string | URL, data?: BodyInit | null) {
      const urlStr = url.toString();
      const destination = !stopRerouting ? getDestination(urlStr) : null;

      if (destination) {
        console.log(`[ConsentGuard] Intercepting Beacon: ${urlStr} -> ${destination}`);
        const proxyUrl = getProxyUrl(destination);
        
        try {
          const finalUrl = new URL(proxyUrl);
          finalUrl.searchParams.set('cuid', userId);
          if (mergedConfig.apiKey) {
            finalUrl.searchParams.set('key', mergedConfig.apiKey);
          }
          
          return originalSendBeacon.call(navigator, finalUrl.toString(), data);
        } catch (err) {
          console.error('[ConsentGuard] Beacon routing error:', err);
          if (mergedConfig.dangerouslyAllowOnError) {
            return originalSendBeacon.call(navigator, url, data);
          }
          return true; // Pretend it succeeded
        }
      }

      return originalSendBeacon.call(navigator, url, data);
    };
  }
}

/**
 * Observe DOM mutations to catch dynamically added scripts or trackers.
 */
function observeMutations() {
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeName === 'SCRIPT') {
          const script = node as HTMLScriptElement;
          if (script.src) {
            console.log('[ConsentGuard] Caught dynamic script:', script.src);
          }
        }
      });
    });
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

/**
 * Utility to persist/retrieve ConsentGuard User ID
 */
function getOrSetUserId(config: ClientConfig): string {
  const cookieName = config.cookieName || 'cuid';
  
  if (typeof window !== 'undefined' && (window as any).__consentGuardUserId) {
    return (window as any).__consentGuardUserId;
  }

  if (typeof window !== 'undefined') {
    const params = new URLSearchParams(window.location.search);
    const urlId = params.get('cg_user_id') || params.get('cuid');
    if (urlId) {
      setCookie(cookieName, urlId);
      localStorage.setItem('cg_user_id', urlId);
      return urlId;
    }
  }

  let id = getCookie(cookieName);
  if (id) {
    return id;
  }

  if (typeof window !== 'undefined') {
    id = localStorage.getItem('cg_user_id');
  }

  if (!id) {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      id = crypto.randomUUID();
    } else {
      id = 'u_' + Math.random().toString(36).substring(2, 15);
    }
  }

  setCookie(cookieName, id);
  if (typeof window !== 'undefined') {
    localStorage.setItem('cg_user_id', id);
  }
  return id;
}

/**
 * Helper to handle consent granting via URL parameters
 */
function handleUrlConsent(userId: string, adminUrl: string) {
  if (typeof window === 'undefined') return;
  
  const params = new URLSearchParams(window.location.search);
  const consentStr = params.get('cg_consent');
  
  if (consentStr) {
    console.log('[ConsentGuard] Found cg_consent in URL:', consentStr);
    const purposes: Record<string, boolean> = {
      necessary: true
    };
    
    consentStr.split(',').forEach(p => {
      purposes[p.trim()] = true;
    });
    
    fetch(`${adminUrl}/consent/${userId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer dev-admin-secret'
      },
      body: JSON.stringify({
        purposes,
        timestamp: Date.now(),
        metadata: { source: 'url_param' }
      })
    })
    .then(r => r.json())
    .then(data => console.log('[ConsentGuard] Consent updated via URL:', data))
    .catch(err => console.error('[ConsentGuard] Failed to update consent via URL:', err));
  }
}

// Support for TypeScript augmentation of XHR
declare global {
  interface XMLHttpRequest {
    _cgDestination?: string;
    _cgOriginalUrl?: string;
  }
}

// Auto-init
if (typeof window !== 'undefined') {
  const metaConfig = getConfigFromMeta();
  const windowConfig = (window as any).__consentGuardConfig || {};
  const config = { ...metaConfig, ...windowConfig };
  init(config);
}

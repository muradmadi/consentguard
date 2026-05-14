console.log("[ConsentGuard] Library loaded");
const DEFAULT_CONFIG = {
  proxyUrl: "http://localhost:3000/ingest",
  destinations: {
    "google-analytics.com": "ga4",
    "api.mixpanel.com": "mixpanel",
    "segment.io": "segment"
  }
};
function init(config) {
  if (typeof window === "undefined") return;
  const mergedConfig = {
    ...DEFAULT_CONFIG,
    ...config
  };
  const userId = mergedConfig.userId || getOrSetUserId();
  console.log("[ConsentGuard] Initialized with User ID:", userId);
  function getDestination(url) {
    for (const [domain, id] of Object.entries(mergedConfig.destinations)) {
      if (url.includes(domain)) return id;
    }
    return null;
  }
  function getProxyUrl(destination) {
    return `${mergedConfig.proxyUrl}/${destination}`;
  }
  const originalFetch = window.fetch;
  window.fetch = async (input, init2) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const destination = getDestination(url);
    if (destination) {
      console.log(`[ConsentGuard] Intercepting Fetch: ${url} -> ${destination}`);
      const proxyUrl = getProxyUrl(destination);
      const headers = new Headers(init2 == null ? void 0 : init2.headers);
      headers.set("X-Consent-UserId", userId);
      headers.set("X-Original-Url", url);
      return originalFetch(proxyUrl, {
        ...init2,
        headers
      });
    }
    return originalFetch(input, init2);
  };
  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;
  XHR.open = function(method, url, ...args) {
    const urlStr = url.toString();
    const destination = getDestination(urlStr);
    if (destination) {
      this._cgDestination = destination;
      this._cgOriginalUrl = urlStr;
      const proxyUrl = getProxyUrl(destination);
      console.log(`[ConsentGuard] Intercepting XHR: ${urlStr} -> ${destination}`);
      return originalOpen.apply(this, [method, proxyUrl, ...args]);
    }
    return originalOpen.apply(this, [method, url, ...args]);
  };
  XHR.send = function(body) {
    if (this._cgDestination) {
      this.setRequestHeader("X-Consent-UserId", userId);
      this.setRequestHeader("X-Original-Url", this._cgOriginalUrl);
    }
    return originalSend.apply(this, [body]);
  };
  if (navigator.sendBeacon) {
    const originalSendBeacon = navigator.sendBeacon;
    navigator.sendBeacon = function(url, data) {
      const urlStr = url.toString();
      const destination = getDestination(urlStr);
      if (destination) {
        console.log(`[ConsentGuard] Intercepting Beacon: ${urlStr} -> ${destination}`);
        const proxyUrl = getProxyUrl(destination);
        const finalUrl = new URL(proxyUrl);
        finalUrl.searchParams.set("cuid", userId);
        return originalSendBeacon.call(navigator, finalUrl.toString(), data);
      }
      return originalSendBeacon.call(navigator, url, data);
    };
  }
}
function getOrSetUserId() {
  const KEY = "cg_user_id";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = "u_" + Math.random().toString(36).substring(2, 11);
    localStorage.setItem(KEY, id);
  }
  return id;
}
if (typeof window !== "undefined") {
  const config = window.__consentGuardConfig;
  init(config);
}
export {
  init
};

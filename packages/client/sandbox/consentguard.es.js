const m = {
  "google-analytics.com": "ga4",
  "api.mixpanel.com": "mixpanel",
  "segment.io": "segment",
  "amplitude.com": "amplitude",
  "facebook.net": "facebook_pixel"
};
console.log("[ConsentGuard] Library loaded");
const y = {
  proxyUrl: "http://localhost:3000/ingest",
  destinations: m,
  observeMutations: !0
};
function U(s) {
  if (typeof window > "u") return;
  const e = {
    ...y,
    ...s
  }, d = e.userId || C();
  console.log("[ConsentGuard] Initialized with User ID:", d), S(d, e.proxyUrl.replace("/ingest", "")), e.observeMutations && w();
  function t(n) {
    for (const [o, r] of Object.entries(e.destinations))
      if (n.includes(o)) return r;
    return null;
  }
  function l(n) {
    return `${e.proxyUrl}/${n}`;
  }
  const i = window.fetch;
  window.fetch = async (n, o) => {
    const r = typeof n == "string" ? n : n instanceof URL ? n.toString() : n.url, a = t(r);
    if (a) {
      console.log(`[ConsentGuard] Intercepting Fetch: ${r} -> ${a}`);
      const c = l(a), u = new Headers(o == null ? void 0 : o.headers);
      return u.set("X-Consent-UserId", d), u.set("X-Original-Url", r), e.apiKey && u.set("Authorization", `Bearer ${e.apiKey}`), i(c, {
        ...o,
        headers: u
      });
    }
    return i(n, o);
  };
  const g = XMLHttpRequest.prototype, p = g.open, h = g.send;
  if (g.open = function(n, o, ...r) {
    const a = o.toString(), c = t(a);
    if (c) {
      this._cgDestination = c, this._cgOriginalUrl = a;
      const u = l(c);
      return console.log(`[ConsentGuard] Intercepting XHR: ${a} -> ${c}`), p.apply(this, [n, u, ...r]);
    }
    return p.apply(this, [n, o, ...r]);
  }, g.send = function(n) {
    return this._cgDestination && (this.setRequestHeader("X-Consent-UserId", d), this.setRequestHeader("X-Original-Url", this._cgOriginalUrl || ""), e.apiKey && this.setRequestHeader("Authorization", `Bearer ${e.apiKey}`)), h.apply(this, [n]);
  }, navigator.sendBeacon) {
    const n = navigator.sendBeacon;
    navigator.sendBeacon = function(o, r) {
      const a = o.toString(), c = t(a);
      if (c) {
        console.log(`[ConsentGuard] Intercepting Beacon: ${a} -> ${c}`);
        const u = l(c), f = new URL(u);
        return f.searchParams.set("cuid", d), e.apiKey && f.searchParams.set("key", e.apiKey), n.call(navigator, f.toString(), r);
      }
      return n.call(navigator, o, r);
    };
  }
}
function w() {
  new MutationObserver((e) => {
    e.forEach((d) => {
      d.addedNodes.forEach((t) => {
        if (t.nodeName === "SCRIPT") {
          const l = t;
          l.src && console.log("[ConsentGuard] Caught dynamic script:", l.src);
        }
      });
    });
  }).observe(document.documentElement, {
    childList: !0,
    subtree: !0
  });
}
function C() {
  const s = "cg_user_id";
  if (typeof window < "u") {
    const t = new URLSearchParams(window.location.search).get("cg_user_id");
    if (t)
      return localStorage.setItem(s, t), t;
  }
  let e = localStorage.getItem(s);
  return e || (e = "u_" + Math.random().toString(36).substring(2, 11), localStorage.setItem(s, e)), e;
}
function S(s, e) {
  if (typeof window > "u") return;
  const t = new URLSearchParams(window.location.search).get("cg_consent");
  if (t) {
    console.log("[ConsentGuard] Found cg_consent in URL:", t);
    const l = {
      necessary: !0
    };
    t.split(",").forEach((i) => {
      l[i.trim()] = !0;
    }), fetch(`${e}/consent/${s}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer dev-admin-secret"
      },
      body: JSON.stringify({
        purposes: l,
        timestamp: Date.now(),
        metadata: { source: "url_param" }
      })
    }).then((i) => i.json()).then((i) => console.log("[ConsentGuard] Consent updated via URL:", i)).catch((i) => console.error("[ConsentGuard] Failed to update consent via URL:", i));
  }
}
if (typeof window < "u") {
  const s = window.__consentGuardConfig;
  U(s);
}
export {
  U as init
};

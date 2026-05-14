# Client Interceptor Behavioral Specification

## Purpose

`@consentguard/client` is a tiny (<5KB gzipped) script that, when imported once, reroutes **all** analytics/marketing network requests through your ConsentGuard proxy. It requires zero changes to existing analytics code.

## Integration

```js
import "@consentguard/client";
// or
<script src="https://unpkg.com/@consentguard/client@1/dist/consentguard.iife.js"></script>;
```

After loading, the interceptor self‑activates. It auto‑detects the proxy endpoint: by default, it posts to `/analytics/ingest/:destination` on the same origin. Override via:

```js
window.__consentGuardConfig = {
  proxyPath: '/my-proxy',
  domains: ['google-analytics.com', 'api.mixpanel.com', ...] // optional extra domains
}
```

## How It Works

1. **Patches global networking**: Overrides `window.fetch` and `XMLHttpRequest.prototype.send` to inspect outbound requests.
2. **Domain & pattern matching**: Compares request URL against a built‑in list of 100+ analytics endpoints (e.g., `*.google-analytics.com`, `api.mixpanel.com/track`, `connect.facebook.net`). Custom patterns from config are merged.
3. **Rerouting**: When a match is detected, the interceptor:
   - Extracts the destination name (e.g., `ga4`, `mixpanel`) from URL patterns.
   - Captures the request body (for POSTs).
   - Creates a **new** request to `POST <proxyPath>/ingest/<destination>` with the original body and headers.
   - Returns a fake `204` response to the calling analytics SDK.
4. **Consent user ID**: The interceptor reads `X-Consent-UserId` from a cookie named `cuid` (configurable) or a global `window.__consentGuardUserId`. If missing, a random anonymous ID is generated and persisted in the cookie.

## Fallback & Resilience

- If the proxy is unreachable, the interceptor silently drops the analytics event (avoids breaking the page).
- If the proxy returns `403`, the interceptor assumes misconfiguration and stops rerouting for that page session, falling back to direct calls (or blocking, depending on `dangerouslyAllowOnError` setting, default `false`).
- It does **not** intercept relative URLs, `data:` URIs, or `blob:`.

## Compatibility

- Works with all major analytics SDKs (gtag, analytics.js, Mixpanel, Amplitude, Segment, Fbq, etc.).
- Does not interfere with other Service Workers or network interceptors (uses `addEventListener`-based wrapping).
- Does not break SPA navigation; resets on soft page changes.

## Configuration Injection Points

- `window.__consentGuardConfig` – set before script loads.
- `<meta name="consentguard-config" content='{"proxyPath":"..."}'>` (JSON) parsed on init.

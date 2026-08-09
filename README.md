# ConsentGuard

A self-hostable consent-enforcing proxy for third-party analytics.

**Status:** early prototype. One destination (GA4 via Measurement Protocol) is wired end-to-end. Five more (Mixpanel, Amplitude, Meta Pixel, TikTok, Hotjar) have destination rules defined but are not yet translated to their vendor request formats — treat those as scaffolding, not working forwarders.

This started as a portfolio exercise to explore a specific idea: what if a server-side proxy sat between your app and every analytics vendor, checked the user's consent state, and either forwarded, scrubbed, or dropped each request? The core loop works. The vendor coverage does not yet.

## What actually works today

- **Client interceptor** (`@consentguard/client`, ~5 KB) patches `fetch`, `XMLHttpRequest`, and `sendBeacon`. Requests matching a small pattern list get rerouted to your proxy.
- **Proxy server** (`@consentguard/server`, Hono) looks up the user's consent state, applies field-level transformations (`strip`, `hash`, `redact`), and forwards the payload upstream.
- **GA4 adapter** translates intercepted GA4 beacons into the [Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4) and forwards them to `mp/collect` using a server-side `measurement_id` + `api_secret`. This is the one destination that actually works against a real vendor endpoint.
- **Storage** — memory, Redis, or Cloudflare KV. Hybrid layer wraps any of them with a bounded in-memory LRU cache.
- **CMP webhook receivers** for OneTrust and Cookiebot payloads.
- **Admin dashboard** (React + Vite) served at `/dashboard`. Rule editor, live traffic, audit log.
- **CLI** (`@consentguard/cli`) for `init`, `start`, `status`, `logs`.

## What is deliberately not yet built

- **Mixpanel / Amplitude / Meta / TikTok / Hotjar** — declarative field rules exist but no per-vendor adapter translates the intercepted request into the vendor's actual API format. These will 502 against real endpoints.
- **TCF v2 integration** — the client does not read IAB TCF signals. Consent is set via the API from your own banner code.
- **Multi-tenant / RBAC / DPIA templates** — this is a single-tenant demo.

## Quick start

Requires Node 20+ and (optionally) Redis. Without Redis, the proxy runs against in-memory storage — fine for the demo, resets on restart.

```bash
npm install
npm run build
CG_STORAGE=memory \
  CG_AUTH_SECRET=dev-proxy-secret \
  ADMIN_SECRET=dev-admin-secret \
  GA4_MEASUREMENT_ID=G-XXXXXXX \
  GA4_API_SECRET=your-mp-secret \
  node packages/server/dist/index.js
```

Then open `examples/kitchen-sink/index.html` and grant analytics consent. Fire a GA4 event and check the dashboard at `http://localhost:3000/dashboard` — if `GA4_MEASUREMENT_ID` + `GA4_API_SECRET` are set to real values, the event will appear in your GA4 realtime report.

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md).

## Security posture

- **The proxy MUST be same-origin with the app**, or fronted by trusted infrastructure. Cross-origin deployment requires configuring `CG_ALLOWED_ORIGINS`.
- No secrets are placed in the browser bundle. Consent is granted via a public `POST /consent/self` endpoint that trusts the browser's `cuid` cookie.
- Admin endpoints (`/api/rules`, `/audit`, `/api/debug/reset`) require `Authorization: Bearer $ADMIN_SECRET`.
- Ingest endpoints reject requests whose `Origin` header is not in the allowlist.

## Packages

| Package | Description |
| --- | --- |
| [`@consentguard/client`](./packages/client) | Browser interceptor for `fetch`, `XHR`, `sendBeacon`. |
| [`@consentguard/server`](./packages/server) | Hono proxy with per-vendor adapters and consent enforcement. |
| [`@consentguard/shared`](./packages/shared) | Zod schemas and shared types. |
| [`@consentguard/cli`](./packages/cli) | Init / start / status / logs. |
| [`@consentguard/admin`](./packages/admin) | Admin dashboard (React + Vite). |

## License

MIT.

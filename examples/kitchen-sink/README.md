# Kitchen Sink Demo

A minimal same-origin playground for ConsentGuard.

## Run it

From the repo root:

```bash
npm install
npm run build

# in-memory storage, no Redis needed
CG_STORAGE=memory \
  ADMIN_SECRET=dev-admin-secret \
  CG_ALLOWED_ORIGINS=http://localhost:3000 \
  GA4_MEASUREMENT_ID=G-XXXXXXX \
  GA4_API_SECRET=your-mp-secret \
  node packages/server/dist/index.js
```

Then open http://localhost:3000/dashboard (admin UI) and, in a separate tab, open [`index.html`](./index.html) via `http://localhost:3000/consentguard-client.js`-adjacent hosting.

The simplest way to serve `index.html` same-origin with the proxy is to open it from a static file server on the same port, or paste its contents behind a route in your own app. If you just double-click it (`file://…`), the client bundle won't load and the proxy will reject cross-origin ingest requests — which is the whole point.

## What to try

1. Click **Fire Google Analytics 4** without consent → the client rewrites the URL to `/ingest/ga4`, the proxy sees no consent, and drops the request (204). Check the dashboard: one blocked event.
2. Click **Accept all** → `POST /consent/self` with your cookie's user id. If the proxy had buffered requests for you, they replay in the background.
3. Fire GA4 again → the proxy translates the gtag beacon into Measurement Protocol JSON and forwards it to `https://www.google-analytics.com/mp/collect`. If your `GA4_MEASUREMENT_ID` is real, the event will show up in your GA4 Realtime report within ~30s.

## What doesn't work yet

Mixpanel, Meta Pixel, TikTok, and other "stub" destinations have consent rules but no vendor adapter. Firing them will pass consent, drop at the forward step, and audit as `blocked` with reason `no_adapter_and_no_upstream_url`. That's on purpose — writing a real adapter for each vendor is not free, and pretending otherwise would defeat the point of this exercise.

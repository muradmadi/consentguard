## Overview
ConsentGuard is a dual‑mode consent enforcement proxy: a lightweight **server** (Hono‑based) and a **client interceptor** (vanilla JS). Together they form an infra‑level privacy guard that inspects, scrubs, and forwards analytics/marketing requests.
## Runtime & Frameworks
- **Server**: [Hono](https://hono.dev/) v4+, run on **Node.js 18+** (primary target). Optional adapters for Bun, Deno, Cloudflare Workers.
- **Cache**: **Redis 7+** via `ioredis`. Key pattern: `consent:{userId}`.
- **Containerisation**: Multi‑stage **Docker** image (Alpine‑based), exposing port `3000`.
## Module Structure (npm package `consentguard`)
```text
consentguard
├── packages
│   ├── client          // @consentguard/client
│   │   └── src/index.ts   // fetch/XHR interceptor
│   ├── server          // @consentguard/server
│   │   ├── src/index.ts   // Hono app factory & start
│   │   ├── src/middleware  // consent proxy middleware
│   │   ├── src/engine     // rule resolution, transformations
│   │   └── src/destinations // curated registry (JSON)
│   └── cli             // npx consentguard
└── shared
    └── config.ts       // shared config types & defaults
```
## Internal Request Lifecycle (Proxy)
1. **Receive** `POST /ingest/:destination` with JSON payload, headers `X-Consent-UserId` (or cookie `cuid`).
2. **Resolve consent**: Fetch from Redis (`consent:{userId}`). Fallback: `deny all` if cache miss.
3. **Match destination**: Look up rule set from registry (`ga4`, `mixpanel`, …). Unknown destinations → apply safe default (strip all `string` fields > 50 chars, remove common PII keys).
4. **Enforce consent**:
    - If consent for required category is `false` → return `204 No Content` (block).
    - If `true` → apply field‑level stripping/hashing as defined.
5. **Forward**: `fetch` the scrubbed payload to the real endpoint (API key from env/config). Return upstream status to client (usually `204`).
## Design Decisions
- **Stateless proxy**: No payload buffering or persistence. All decision data comes from Redis.
- **No client SDK pollution**: Client interceptor is a self‑contained script; no global `window.consentGuard` API unless explicitly opted‑in.
- **Pluggable transformations**: Each destination rule includes a `pipeline` of simple transforms (`strip`, `hash`, `redact`). Advanced users can supply custom functions.
- **Observability**: Structured JSON logs to stdout; Prometheus metrics exposed at `/metrics` (port `9090` internally).
## Error Boundaries
- All Redis operations wrapped with timeout (100ms). On timeout → fail open or closed (configurable; default **deny**).
- Destination fetch failures → log error, return `502` to client (but never expose internal API keys).
- Payloads that fail JSON parse → reject with `400`.

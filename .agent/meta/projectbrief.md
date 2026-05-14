# Project Brief: ConsentGuard
**A Universal, Privacy-First Consent Enforcement Proxy for the Modern Web**
## 1. Project Overview
**ConsentGuard** is an open-source, infrastructure-level privacy middleware that solves the fragmented, high-risk problem of consent enforcement in web analytics and marketing. It is delivered as a single npm package that can be dropped into any Node.js project and immediately brings **every** third-party analytics, marketing, and tracking tool into GDPR/CCPA compliance—without changing a line of existing instrumentation code.

Where current solutions are either platform-locked (Segment), commercial-only (Transcend), or require running a separate heavy service (Fides), ConsentGuard fills the gap: a lightweight, universal, developer-first “privacy guard” that sits at the network layer and ensures that data never leaves the system without consent.
## 2. Problem Statement
- Marketers and product teams embed tens of tracking pixels and SDKs (Google Analytics, Facebook Pixel, Mixpanel, Amplitude, Hotjar, etc.) across a website.
- When a user opts out, developers must manually add conditional logic inside every analytics call—or worse, rely on each vendor’s own opt-out mechanism, which is inconsistent and often ignored.
- Even when blocked, data can leak: client IPs, email hashes, user IDs, and custom traits often still appear in network requests.
- Non-compliance can result in fines up to €20 million or 4% of global annual turnover under GDPR.
- No easy-to-adopt tool exists today that can be `npm install`ed and instantly enforce consent across **all** tools, retroactively, without touching the existing codebase.
## 3. Solution Vision
ConsentGuard is a **dual-mode middleware**:
1.  **Client-side**: A tiny, zero-dependency interceptor that overrides `fetch` and `XMLHttpRequest` to redirect **all** outgoing analytics/marketing requests through your own consent proxy, no matter which SDK generates them.
2.  **Server-side**: A Hono-based HTTP proxy (runnable as a standalone microservice or mounted as middleware in an existing Node.js app) that inspects each request, checks a fast Redis consent cache, and applies one of three actions:
    - **Block** the request entirely.
    - **Strip** PII (IP, email, user ID, device fingerprint) according to per-destination rules, then forward.
    - **Pass through** unchanged when full consent is given.
The result: a single, auditable enforcement point that works with every analytics tool, past and future, without any SDK modifications.
## 4. Key Features
### 4.1 Universal Client Interceptor
- A small script (`consentguard/client`) that, when imported once, patches the browser’s networking primitives.
- Auto-detects 100+ known analytics/marketing endpoints (configurable) and rewrites requests to point to the local proxy (`/ingest/:destination`).
- Fallback mode for unknown destinations: flags them for manual review or blocks them by default.
### 4.2 Consent Decision Engine
- Fast lookups via Redis (sub-millisecond) keyed on a user-specific `consentUserId` (stored in a cookie or JWT).
- Consent state is a simple JSON object mapping categories (`analytics`, `marketing`, `personalization`, `necessary`) to `true`/`false`.
- Exposes an API (`PUT /consent/:userId`) for consent banners to update state.
### 4.3 Per-Destination Transformation Rules
- Declarative YAML/JS config that defines for each destination (e.g., `ga4`, `mixpanel`, `facebook_pixel`):
    - Required consent category.
    - Fields to strip/redact (supports nested paths and wildcards).
    - Whether to hash identifiers (e.g., SHA-256 email) instead of removing them.
    - Custom transformation functions (advanced).
### 4.4 Pluggable Architecture
- **Standalone service**: `npx consentguard start` runs a Dockerized proxy.
- **Middleware mode**: Mounts directly into an Express, Next.js, Hono, Fastify, or Nuxt server (`app.use('/analytics', consentProxyMiddleware())`), sharing existing resources.
- Works in any Node.js runtime (including Bun, Deno, Cloudflare Workers with some adaptation).
### 4.5 Observability & Auditing
- Structured JSON logging of every consent decision (block/strip/pass) with timestamp, destination, and user pseudonymous identifier.
- Prometheus metrics endpoint (`/metrics`) for request counts, latency, and consent status distributions.
- Admin dashboard (optional) for real-time monitoring and replaying blocked events in a sandbox.
### 4.6 Consent Management API
- Minimalist built-in API to create/update consent records, so existing consent banners can integrate with a single fetch.
- Pluggable to external Consent Management Platforms (OneTrust, Cookiebot) via webhooks.
### 4.7 Multi‑Tenancy & Environment Support
- The proxy can be configured per environment (dev, staging, prod) with different destination API keys.
- Multi-tenancy support: different consent policies for different applications within the same proxy instance.
## 5. Target Audience
- **Developers** who want to add privacy compliance to their project in minutes, not weeks.
- **Privacy Engineers** needing a transparent, auditable enforcement layer that fits into CI/CD.
- **Agencies & Startups** that can’t afford enterprise privacy tools but must comply with regulations.
- **Platform Teams** building internal analytics infrastructure that respects user choice by default.
## 6. Technical Architecture
...
### Components
1.  **Client Interceptor (`@consentguard/client`)**
    - Published as an ESM/CJS bundle (<5 KB gzipped).
    - Configurable via `window.__consentGuardConfig` or a `data-consentguard-config` script tag.
2.  **Consent Proxy Server / Middleware (`@consentguard/server`)**
    - Built on Hono for its exceptional performance and multi-runtime compatibility.
    - Accepts requests at `/ingest/:destination` with the original analytics payload as JSON.
    - Fetches consent state from Redis (key pattern: `consent:{userId}`).
    - Applies the rule engine, forwards the scrubbed payload to the real destination, and returns a `204` or appropriate status.
3.  **Rule Engine**
    - A deterministic, pluggable pipeline: `resolveConsent` → `checkCategory` → `applyTransformations` → `forward`.
    - Built-in transformations: `strip`, `hash`, `drop`, `redact` (with regex), `custom`.
    - Rules can be defined in a `.consentguardrc.js` file or passed programmatically.
4.  **Redis Consent Store**
    - A single Redis instance (or cluster) is all that’s needed.
    - Consent data schema:
      ```json
      {
        "userId": "a1b2c3",
        "timestamp": 1715692800,
        "purposes": {
          "necessary": true,
          "analytics": false,
          "marketing": false,
          "personalization": true
        },
        "metadata": { "source": "cookiebot", "version": "v2" }
      }
      ```
5. **Configuration & Destination Registry**
    - A curated, versioned registry of common analytics endpoints (GA4, UA, Mixpanel, Amplitude, Segment, HubSpot, Facebook, LinkedIn, Twitter, TikTok, Hotjar, FullStory, etc.).
    - Registry includes default transformation rules verified by the community.
    - Custom destinations can be added via config.
## 7. How It Achieves “Works with Any Module”
This is the core innovation. ConsentGuard achieves universal compatibility through two mechanisms:
- **Client-side network interception**: It doesn’t require you to change your analytics setup. Whether you use `gtag.js`, `mixpanel.track()`, or a custom wrapper, the interceptor sees the raw `fetch`/`XHR` call and reroutes it to the proxy. Thus, it works with _any_ analytics module, from official SDKs to homegrown scripts.
- **Server-side payload transformation**: The proxy understands the shape of each destination’s API payload (e.g., Google Analytics 4 Measurement Protocol, Mixpanel’s `/track` endpoint) and can surgically remove PII while keeping event structure intact. For unknown endpoints, a safe default (strip all string values longer than X characters, remove `email`/`ip` fields) is applied.

By combining these, a developer can install ConsentGuard and, **without modifying a single line of their analytics code**, achieve:
- Full consent enforcement for all existing and future tracking.
- A single place to audit and debug data flows.
- The ability to switch analytics tools without re‑implementing privacy logic.
## 8. Implementation Phases
### Phase 1: Core Proxy & Client Interceptor (MVP – 2 weeks)
- Hono proxy with Redis consent lookup.
- Per-destination rules for top 5 destinations (GA4, Mixpanel, Amplitude, Facebook Pixel, Segment).
- Basic client interceptor that rewrites known endpoints.
- NPM package scaffold: `consentguard` with `start` command.
- Example integration with a simple HTML page and a Next.js app.
### Phase 2: Production Hardening & Configuration (2 weeks)
- Complete destination registry (20+ tools) with community contributions.
- Robust client interceptor: fallback handling, async consent state retrieval, mutation observer for late-loading scripts.
- Environment variable and `.consentguardrc` configuration.
- Built-in Prometheus metrics and structured logging.
- Docker image and one-click deployment to [Fly.io](https://fly.io/) / Railway.
### Phase 3: Advanced Features & Ecosystem (2 weeks)
- Admin dashboard (optional, run as a separate service or static site).
- Hashing and partial redaction (e.g., hash email before sending to Meta for advanced matching).
- Server-side event buffering and replay for when consent is granted later.
- Webhook integrations with OneTrust/Cookiebot.
- CLI tool to scaffold consent flow in new projects.
### Phase 4: Multi‑Runtime & Edge Support (1 week)
- Adapt Hono server to run on Cloudflare Workers, Deno Deploy, and Bun.
- Provide lightweight alternatives to Redis (in‑memory LRU cache, Cloudflare KV) for smaller deployments.
## 9. Example Usage (End-State Developer Experience)
### Installation
```bash
npm install consentguard
```
### Server‑side (Express example)
```js
const express = require('express')
const { consentProxyMiddleware } = require('consentguard/server')
const app = express()
app.use('/analytics', consentProxyMiddleware({
  redisUrl: process.env.REDIS_URL,
  destinations: {
    ga4: { measurementId: 'G-XXXX', apiSecret: '...' },
    mixpanel: { token: '...' }
  }
}))
app.listen(3000)
```
### Client‑side (just import in your app entry)
```js
import 'consentguard/client'
// All analytics calls continue as before, but now they respect consent.
gtag('event', 'purchase', { ... })
mixpanel.track('Sign Up', { email: user.email }) // email will be stripped if marketing consent = false
```
### Consent Banner Integration
```js
// When user updates preferences:
fetch('/analytics/consent', {
  method: 'PUT',
  body: JSON.stringify({ userId: currentUser, purposes: { analytics: false, marketing: true } })
})
```
## 10. Success Metrics
1. **Adoption**: 1,000+ GitHub stars and 500+ weekly npm downloads within 3 months of public launch.
2. **Compatibility**: Works seamlessly with 30+ popular analytics/marketing SDKs without issues.
3. **Compliance**: Passes simulated GDPR/CCPA audits when used as directed.
4. **Latency**: Proxy adds < 10ms overhead to analytics requests at p99.
5. **Community**: 10+ external contributors and a growing destination registry.
---
## 11. Expected End State
**What the project has accomplished:**
- ConsentGuard has become the standard, lightweight “privacy proxy” for the Node.js ecosystem, much like `helmet` is for security headers.
- Developers everywhere can make any web application fully consent‑compliant by adding a single package and a few lines of configuration.
- The fragmented, error‑prone practice of manually wrapping every analytics call with consent checks is obsolete.
- Privacy‑by‑infrastructure is now as easy as `npm install consentguard`.
**What the final product looks like:**
- A polished npm monorepo containing `@consentguard/client`, `@consentguard/server`, and a CLI.
- A vibrant community‑maintained registry of destination rules covering 50+ platforms.
- Comprehensive documentation, tutorials, and a live demo site that shows the proxy in action—visitors can toggle their consent and watch analytics requests vanish or reappear in real time.
- Optional managed cloud offering (ConsentGuard Cloud) that handles proxy hosting and consent storage for teams that don’t want to self‑host, generating a sustainable open-source business model.
- A recognized open standard for consent enforcement at the network edge, with integrations in popular frameworks (Next.js plugin, Nuxt module, Express middleware).
The ultimate outcome: **no user data flows where it shouldn’t, and no developer has to think about it.** That’s the world ConsentGuard creates.
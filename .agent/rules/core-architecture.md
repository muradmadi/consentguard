---
trigger: always_on
---

# ConsentGuard Core Architecture & Agent Rules

**⚠️ CRITICAL INSTRUCTION FOR AI AGENTS & DEVELOPERS ⚠️**
This document contains the non-negotiable architectural constraints for the ConsentGuard project. **You must strictly adhere to these rules in every code modification, suggestion, or refactoring.**

Failure to follow these rules will compromise the project's security, performance guarantees, and core value proposition.

---

## 1. Client-Side Constraints (`@consentguard/client`)

- **RULE 1: STRICT ZERO-DEPENDENCY POLICY**
  - **Mandate:** Do NOT import any external NPM packages (e.g., `lodash`, `axios`, `uuid`) into the client codebase.
  - **Reason:** The client interceptor must be universally embeddable without bloating the host application.
  - **Action:** Rely exclusively on Vanilla JavaScript and standard Browser/DOM APIs (`fetch`, `XMLHttpRequest`, `cookie`, `crypto.randomUUID()`).

- **RULE 2: THE 5KB HARD LIMIT**
  - **Mandate:** The final gzipped bundle size of `@consentguard/client` MUST remain under 5KB.
  - **Action:** When adding new interception patterns or logic, heavily scrutinize the byte footprint. Offload complex processing to the server proxy wherever possible.

- **RULE 3: DO NO HARM (SILENT FALLBACKS)**
  - **Mandate:** The interceptor runs on the host website's main thread and must **never** throw unhandled exceptions that could crash the host page.
  - **Action:** Wrap all network patching (`window.fetch`, `XHR.send`) and interception logic in defensive `try/catch` blocks. If the proxy is unreachable (e.g., 502 Bad Gateway) or an error occurs, log a warning to the console and silently drop the event (or fallback to direct routing based on the user's config).

- **RULE 4: SEPARATION OF CONCERNS (NO UI)**
  - **Mandate:** The client script is strictly a network interceptor.
  - **Action:** Do NOT write logic to render consent banners, manipulate the DOM (other than reading script tags), or manage UI state. Read consent IDs exclusively from `window.__consentGuardUserId` or the `cuid` cookie.

---

## 2. Server-Side Constraints (`@consentguard/server`)

- **RULE 5: EDGE-COMPATIBLE STATELESSNESS**
  - **Mandate:** The Hono server must remain 100% stateless.
  - **Reason:** The proxy is designed to eventually run on Cloudflare Workers, Deno, and Bun.
  - **Action:** All consent state MUST come from Redis. Do NOT use Node.js-specific native modules (like `fs`, `child_process`, or `path`) in the core engine routing or transformation logic.

- **RULE 6: STRICT REDIS TIMEOUTS**
  - **Mandate:** Analytics ingestion routing must add near-zero latency (< 10ms overhead).
  - **Action:** Wrap every Redis `GET` operation (for fetching consent state) in a strict timeout (e.g., 100ms maximum).

- **RULE 7: FAIL-CLOSED DEFAULT**
  - **Mandate:** Privacy is the default.
  - **Action:** If a Redis lookup times out, fails, or results in a cache miss, the engine MUST default to the `defaultConsent` configuration (which must default to `deny`/block). Never allow an event to pass through un-scrubbed if the consent state is unknown or the database is down.

---

## 3. Security & Data Privacy Constraints

- **RULE 8: OPAQUE CLIENT RESPONSES**
  - **Mandate:** Never leak upstream data back to the client.
  - **Reason:** Upstream analytics APIs (like Mixpanel or GA4) may return responses containing internal project IDs, account details, or un-scrubbed data.
  - **Action:** The proxy MUST intercept the upstream HTTP response and return a generic `204 No Content` to the browser on success, or a generic `400/502` on failure. Do NOT pipe the raw response body back to the client.

- **RULE 9: API KEY SECRECY**
  - **Mandate:** Upstream API keys and secrets must never touch the browser.
  - **Action:** Upstream keys (e.g., GA4 Measurement Secret) must only be read from the server's environment variables or `.consentguardrc.js` file. They must never be bundled into the client script or echoed in HTTP headers.

- **RULE 10: MANDATORY PROXY AUTHENTICATION**
  - **Mandate:** The proxy cannot be used as an open relay for spam.
  - **Action:** Every request to `POST /ingest/:destination` MUST validate the `Authorization: Bearer <PROXY_SECRET>` header. The server MUST throw a fatal error and refuse to boot if `CG_AUTH_SECRET` is missing from the environment.

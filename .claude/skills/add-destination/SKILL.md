---
name: add-destination
description: Add or extend an analytics destination in Sluice — the redaction rule, registry entry, client interception pattern, optional vendor adapter, and tests. Use when asked to support a new vendor (Meta, Mixpanel, Segment, Klaviyo…), to scrub an additional field for an existing vendor, or when a payload is reaching a vendor with personal data still in it.
---

# Adding a destination

A destination is the unit of coverage in Sluice. Adding one badly leaves a vendor
listed as supported while personal data still reaches it, which is the exact failure
this project exists to prevent. Work through the steps in order.

## 1. Find out what the vendor actually receives

Do not guess field names. Establish the real payload shape first, from vendor docs or a
captured request. You need two shapes, and they are usually different:

- **What the browser sends** — the beacon the SDK emits (often form-encoded or a query
  string, e.g. GA4's `/g/collect?en=…&ep.foo=…`).
- **What the server-side API accepts** — the documented ingestion schema
  (e.g. GA4 Measurement Protocol, Meta Conversions API).

If those two shapes differ, this destination needs an adapter (step 4). If the vendor
accepts the browser's payload as-is over JSON, it does not.

Then list every field in the server-side shape that can carry personal data: email,
phone, name, address, IP, user agent, raw user ids, order or customer identifiers.
Those become the transformations.

The value scan (`engine/detectors/`) already catches emails, phones, IPs, and card
numbers by shape wherever they appear, so a declared path is for what the scan cannot
see: names, addresses, raw user ids, and anything vendor-specific. Do not skip declaring
a known path because the scan would probably catch it — the declared pass runs first and
is the cheap, exact layer.

## 2. Write the rule

Create `packages/server/src/destinations/<vendor>.ts`:

```ts
import { DestinationRule } from '@sluice/shared'

export const vendor: DestinationRule = {
  id: 'vendor',
  category: 'analytics', // or 'marketing' — drives the consent gate
  endpoints: ['vendor.com/collect'],
  upstreamUrl: 'https://api.vendor.com/v1/track', // omit when an adapter builds the URL
  transformations: [
    { path: 'user.email', action: 'hash' },
    { path: 'events.*.properties.ip', action: 'strip' },
    { path: 'events.*.properties.order_id', action: 'redact', pattern: 'ORDER-[0-9]+' },
  ],
}
```

Rules on the rule:

- `path` is dot-separated and resolved by `engine/transformer.ts`. `*` is an array
  wildcard only — it does not match object keys. Paths target the **server-side** shape,
  after any adapter has run.
- `action` is `strip` (delete), `hash` (salted SHA-256, lowercased+trimmed first), or
  `redact` (regex replace, requires `pattern`).
- Prefer `hash` over `strip` for anything the vendor needs for identity resolution —
  Meta and Google both accept pre-hashed emails and phones. Prefer `strip` for data the
  vendor has no legitimate need for at all, like raw IPs.
- `category` decides which consent purpose gates the destination. Anything ad- or
  audience-related is `marketing`, not `analytics`.

Register it in `packages/server/src/destinations/registry.ts`.

## 3. Add the interception pattern

Add the domain substring to `INTERCEPTION_PATTERNS` in `packages/client/src/patterns.ts`,
mapped to the same `id` used in the registry.

The client matches with a plain `url.includes(domain)`, so the pattern must be specific
enough not to catch unrelated first-party traffic. These two files are a matched pair:
a pattern with no registry entry makes `/ingest` return `400`, and a registry entry with
no pattern means the vendor is never intercepted in the first place.

## 4. Write the adapter, if step 1 said you need one

Create `packages/server/src/destinations/adapters/<vendor>.ts` implementing
`VendorAdapter`, and register it in `adapters/index.ts`. Model it on
`adapters/ga4.ts`. The adapter must:

- Read the original request from `ctx` — `originalUrl`, `query`, `rawBody`, `jsonBody`,
  `headers` (already lowercased).
- Build the vendor's server-side payload.
- Call `scrubPayload(payload, ctx.rule, { detectors: ctx.serverConfig.detectors })` itself.
  Passing the detectors is what lets an operator turn the value scan off; omitting the
  argument falls back to the default set, which scrubs more than configured, never less.
  It returns `{ payload, report }` — forward
  the scrubbed payload and pass `report` straight through as the forward's `report` field.
  That report is what the audit record is built from, so never synthesise it from the rule:
  an entry must mean the transformation actually fired against this payload.
- Return `{ skip: true, reason }` when required credentials are missing, rather than
  forwarding something incomplete. The caller turns that into a clean `204`.

Credentials go in `getServerConfig` (`packages/server/src/config.ts`) as a namespaced
block, read from env with a `''` default — never a hardcoded fallback.

Without an adapter the request falls through to generic JSON passthrough, which only
works if the vendor accepts the browser's payload verbatim and `upstreamUrl` is set.
That is rarely true. **Do not register a destination whose adapter you did not write
and whose passthrough you did not verify** — a registry entry that cannot forward is
worse than no entry.

## 5. Test it

Two suites, both required:

- `packages/server/src/destinations/adapters/<vendor>.test.ts` — the adapter builds the
  documented payload shape; personal data is absent or hashed in the output; missing
  credentials produce `skip`. Assert on the built body, not on mocks.
- A case in `packages/server/src/app.test.ts` covering the destination end to end
  through `/ingest/<vendor>`.

Then mutation-check: break the transformation in the rule, confirm the test fails,
restore it. A redaction test that passes with redaction disabled is worse than no test.

## 6. Verify

```
just check
```

Report the real output. Then confirm coverage is genuine by checking the audit record
for a request that carried personal data — the destination is only done when the log
shows the transformation actually fired, not merely that it was declared.

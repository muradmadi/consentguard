# Scope decision: PII firewall

**Decided 2026-08-22.** Supersedes the earlier "consent enforcement proxy" framing.

## Why

The project previously tried to be three things at once: a consent enforcer, a
server-side tagging proxy, and a PII scrubber. Each of those has a strong incumbent:

| Framing                  | Who already owns it                                     |
| ------------------------ | ------------------------------------------------------- |
| Consent capture + proof  | OneTrust, Cookiebot, Usercentrics, Didomi, Osano, Klaro |
| Server-side tag delivery | Google Tag Manager server-side, Cloudflare Zaraz, Stape |
| Event pipeline + PII     | RudderStack, Snowplow, Jitsu                            |
| Avoiding the problem     | Plausible, Fathom, Umami, Matomo, PostHog               |

The third row is the closest competition, but those are pipelines you adopt wholesale.
Nobody sells a small, self-hosted thing whose only job is: **personal data does not
reach your analytics vendors, and here is the proof.** That is the gap Sluice takes.

Everything below follows from that.

## Remove

Consent is an _input_ to the firewall, not a feature of it. It arrives from an external
CMP over `/webhooks/:provider`. The following exist only to make Sluice a consent
product, and they go:

- **`POST /consent/self`** (`app.ts`) — a browser-callable consent write API. This is
  CMP surface. Consent comes in over the webhook or not at all.
- **`window.Sluice.setConsent`** and the `setConsent` helper (`packages/client/src/index.ts`).
- **Buffering and replay** — `engine/buffer.ts`, `replayBuffered` in `app.ts`, the
  `BUFFER_PENDING` config, and the `202` branch of `/ingest`. This stores the full
  contents of tracking events for users with no consent record, then replays them.
  It is consent-flow machinery, it processes personal data before a lawful basis
  exists, and it is not firewall behaviour.
- The `202` response from `/ingest`. After this, `/ingest` returns `204`, `400`, `403`,
  or `502` only.

## Keep, but do not extend

- **`ConsentManager`** and the CMP webhooks — a thin allow/deny gate on `rule.category`,
  fed externally. No new features, no new adapters unless a user actually needs one.
- **`@sluice/admin`** — rule editing and the audit view are on-scope operator surface.
- **`@sluice/cli`** — `status` and `logs` are on-scope. `sluice init` currently emits a
  `docker-compose.yml` with `build: .` pointing at a Dockerfile the repo does not ship;
  either ship the Dockerfile or drop the compose generation.

## Build

Ordered. Each is independently shippable and independently commit-able.

### 1. Fix the evidence, because the evidence is the product — **done**

The audit was computed from the rule's _declared_ transformation list, so a request
carrying no personal data was logged as `decision: 'scrubbed'` with a full list of
transformations that matched nothing.

`scrubPayload` now returns `{ payload, report }`, where the report carries only what
actually changed. `AuditRecordSchema` lives in `@sluice/shared`; `decision` is
`forwarded | blocked | buffered | failed`, written after the upstream call resolves, and
"was anything scrubbed" is `transformations.length > 0`. Two leaks closed alongside it:
buffer replay forwarded raw string payloads unscrubbed, and `sluice logs` compared an ISO
timestamp against `0` so it never printed a line.

Still open, and worth doing next time the rules are touched: a **rule-health view**. The
report knows which declared transformations never match, which would surface dead rules
like `mixpanel.ts`'s `properties.$email` — a path that cannot exist because that
destination has no adapter. The audit deliberately does not store unmatched entries, so
this needs its own surface.

### 2. Detect personal data that was not declared — **done**

A field used to be scrubbed only if someone wrote its exact dotted path into a rule,
which caught known leaks and nothing else. The expensive incidents are the fields nobody
knew were being sent.

`scrubPayload` now runs a second pass over the whole payload matching _values_:
`email`, `phone` (E.164 plus separated national formats), `ipv4`, `ipv6`, `credit_card`
(issuer prefix plus Luhn), and `us_ssn` behind an opt-in. Each detector has its own
action — email and phone are hashed so identity resolution survives, addresses and card
numbers are removed — and produces its own audit entry carrying the detector that fired
and the concrete path it fired at. Declared rules run first and stay the precise, cheap
layer on top.

A match covering the whole value gets the detector's action; a match inside a longer
string is redacted in place, because hashing a page URL over one query param would
destroy the event while removing nothing else. `SLUICE_DETECTORS` selects the set;
`off` disables the scan.

Every pattern is deliberately conservative about separators: a bare run of digits is an
order id far more often than a phone number or a card. False positives corrupt analytics
data, which is how a firewall gets switched off.

### 3. Close the interception holes

- Intercept `<img>` requests — `Image.prototype.src` and `setAttribute('src', …)` on
  `HTMLImageElement`. Without this the Meta pixel is entirely uncovered.
- Make `init()` idempotent so a double load cannot double-wrap `fetch`.
- Stop minting a persistent `cuid` cookie before consent exists. Use a session-scoped
  identifier that is promoted to a persistent one only on a consent grant.

### 4. Make the registry honest

`adapters/index.ts` registers exactly one adapter (GA4). Five other destinations are
listed in the registry and cannot forward to their real vendor — `facebook.ts` has a
literal `<PIXEL_ID>` in its `upstreamUrl`.

Either write the adapter or remove the entry. A registry that lists destinations it
cannot serve is the same class of dishonesty as the audit bug in item 1.

Priority order if adapters get written: Meta CAPI, then Mixpanel.

## Non-goals

Restated from `CLAUDE.md` because this is where they get argued with: no consent UI,
no CDP, no evasion features, no multi-tenancy. A request that implies one of these
gets raised with the user before any code is written.

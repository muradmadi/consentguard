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
CMP over `/webhooks/:provider`. The following existed only to make Sluice a consent
product, and are **gone** — carried out as part of build item 5:

- **`POST /consent/self`** (`app.ts`) — a browser-callable consent write API. This is
  CMP surface. Consent comes in over the webhook or not at all.
- **`window.Sluice.setConsent`** and the `setConsent` helper (`packages/client/src/index.ts`).
- **Buffering and replay** — `engine/buffer.ts`, `replayBuffered` in `app.ts`, the
  `BUFFER_PENDING` config, and the `202` branch of `/ingest`. This stores the full
  contents of tracking events for users with no consent record, then replays them.
  It is consent-flow machinery, it processes personal data before a lawful basis
  exists, and it is not firewall behaviour.
- The `202` response from `/ingest`. `/ingest` now returns `204`, `400`, `403`, `413`,
  or `502` only. `413` is new: the body is capped, and an oversized one is refused
  before it is read.

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

Carried out in item 7: a **rule-health view**. The report knows which declared
transformations never match, which surfaces dead rules like `mixpanel.ts`'s
`properties.$email` — a path that cannot exist because that destination has no adapter.
The audit deliberately does not store unmatched entries, so it got its own surface,
derived from the retained record rather than kept as a counter.

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

### 3. Scrub the URL, not just the body — **done**

Found while looking at item 4, and it outranked it. The generic passthrough forwarded to
`ctx.originalUrl` — the URL the browser had originally targeted — verbatim. Only the body
went through `scrubPayload`. A beacon to `…/track?em=alice@example.com&ip=203.0.113.9`
therefore reached the vendor with both intact, and the audit recorded
`decision: 'forwarded'`, `transformations: []`: true, and damning. It affected every
destination without an adapter, which is six of the seven in the registry.

`engine/url.ts` now runs the query string through `scrubPayload` with each parameter as a
field, so declared paths and the value scan both apply to it, and `buildForward` puts
every forward's URL through it — including a URL an adapter built for itself, so there is
no branch where it can be forgotten. Audit entries from the URL are prefixed `?`
(`?em`, `?ip`), which no dotted body path can collide with.

Two deliberate limits. The path is left alone: it addresses the vendor's API rather than
carrying payload, and rewriting a segment changes what is being called. And a URL is
returned byte-identical when nothing fires, rather than re-encoded, because a vendor may
be checking a signature over it.

Resolved by item 5: the buffer stored `originalUrl` with its query string intact, so
personal data sat in storage for a user with no consent record. Buffering is deleted.

### 4. Close the interception holes — **done, except identity**

Items 1–3 all improved what happens to a request once it arrives. None of that reaches
a request that never arrives, and the pixel transport never did.

`<img>` requests are now intercepted: the interceptor wraps the
`HTMLImageElement.prototype.src` setter and `setAttribute`, and routes through the same
`rewriteTrackingUrl` helper as `sendBeacon`, since neither transport can carry a header.
`init()` is idempotent, guarded on `window.__sluiceInitialized`.

Interception alone would not have been enough. Three things were found in the process:

- **The server dropped pixels anyway.** `buildForward` required a parseable JSON body,
  and a pixel has no body — its whole payload is the query string. A Meta-shaped pixel
  audited as `blocked / unscrubbable_payload` with the upstream never called, so the
  firewall could neither see the request nor serve it. It now forwards a bodyless
  request with an original URL as a `GET`, where `scrubUrl` — built in item 3 — is a
  complete scrub rather than half of one.
- **The client's pattern table had drifted from the registry.** It intercepted
  `facebook.net` (the script CDN) but not `facebook.com/tr` (the beacon the rule itself
  declares), missed `analytics.google.com`, and named a `segment` destination the
  registry has never had, which `/ingest` answers with a `400`. Fixed, and now asserted
  by `server/src/destinations/patterns.test.ts` rather than left to convention.
- **The query string was going to stdout.** Hono's `logger()` slices the path off the
  raw URL, keeping the query, so `?original=…&em=alice@example.com` was logged verbatim
  — including for requests that were blocked. Replaced with a logger that prints the
  pathname. Folded in here rather than split out, because intercepting more pixels would
  have made it strictly worse.

Still open, and deliberately separated: **stop minting a persistent `cuid` cookie before
consent exists**. `getOrSetUserId` writes a 365-day cookie and a `localStorage` entry on
page load. It needs a session-scoped identifier promoted to a persistent one only on a
consent grant, which touches the server's identity resolution and the consent gate — an
identity change, not an interception one.

### 5. Shut the open door — **done**

Items 1–4 all assume the firewall only ever calls the vendor. It did not.

`?original=` and `X-Original-Url` name the URL the browser was heading to, and
`buildForward` forwarded there without ever checking it against the destination rule.
Combined with `POST /consent/self` — which let a browser grant itself any purpose for
any user id it invented — two unauthenticated requests on stock configuration reached
any host the server could route to, and the audit recorded it as a clean forward to the
vendor. The response never returns to the caller, so it was a blind exfiltration and
internal-scanning primitive rather than a read. Five smaller holes were open alongside
it, and all six are closed:

- **Egress is now derived from the rule.** `engine/egress.ts` requires a forward's host
  to match an endpoint the destination rule declares, or the host of its `upstreamUrl`.
  Internal addresses — loopback, private, link-local, the metadata address, and the
  hostnames that resolve inside a network — are refused ahead of the allowlist, so a
  rule cannot declare its way to one. Redirects are not followed: a `3xx` is a second
  destination chosen by whoever answered the first. A refusal is audited as `blocked`
  with the reason, because a refusal is evidence too.
- **The admin secret is no longer compiled into the dashboard.** It was read from
  `VITE_ADMIN_SECRET`, which Vite inlines at build time, into a bundle the proxy serves
  unauthenticated at `/dashboard/*` — so the credential for `/audit`, `/api/rules` and
  `/api/debug/reset` was readable by anyone who opened the page. The operator enters it
  at runtime and it lives in session storage. `just check-dist` fails the gate on
  anything secret-shaped in `packages/*/dist`. The fixed development token is gone from
  the server and the CLI too: both generate one instead.
- **An absent `Origin` is no longer permission.** A configured allowlist stopped
  browsers and nothing else, because every tool that is not a browser omits the header.
- **`/metrics` takes a bearer.** It served the same per-destination counters as
  `/api/stats` to anyone — which vendors a site uses, and how much of its traffic is
  blocked. Admin secret, or an explicitly configured `SLUICE_METRICS_TOKEN`.
- **The body is capped** at `SLUICE_MAX_BODY_BYTES` (64 KiB). `/ingest` is public and
  unauthenticated, and a beacon is a few hundred bytes; the stream is counted as it
  arrives, because `Content-Length` is a claim.

The **Remove** list above was carried out in the same change, because `POST
/consent/self` was the escalation step in the chain and buffering is what stored full
tracking payloads for users who had given no consent.

Still open, and deliberately not done here: the egress check reads the parsed hostname
rather than resolving it, so a destination rule declaring a domain that resolves to a
private address still reaches it. That needs a resolver on the hot path, and reaching it
needs the ability to write destination rules in the first place.

### 6. Make the registry honest

`adapters/index.ts` registers exactly one adapter (GA4). Five other destinations are
listed in the registry and cannot forward to their real vendor — `facebook.ts` has a
literal `<PIXEL_ID>` in its `upstreamUrl`.

Either write the adapter or remove the entry. A registry that lists destinations it
cannot serve is the same class of dishonesty as the audit bug in item 1.

Priority order if adapters get written: Meta CAPI, then Mixpanel.

Note that until then those five destinations forward nowhere: the passthrough now has to
satisfy the egress allowlist, and `facebook.ts`'s `<PIXEL_ID>` upstream still cannot
work. The registry lists them; the firewall refuses them. That is the honest failure
mode, not a substitute for fixing it.

### 7. Make the evidence outlive the request — **done**

Items 1–6 all improved what the record _says_. None of it survived the afternoon.

`AuditLogger` pushed onto a Redis list and called `ltrim(KEY, 0, 999)` on every write.
No archive behind it, no warning when entries rolled off the end, no retention policy,
no export, and no integrity: anyone with Redis access — or, before item 5, anyone at all
via `/api/debug/reset` — could delete or alter history without leaving a trace. `/audit`
returned the newest hundred with no time range, no filters and no pagination. Half the
sentence this repo is judged against is "and there is a per-request record proving it",
and on a site doing modest traffic this morning's proof was gone by lunchtime.

The record is now a file. `engine/audit/sink/file.ts` appends NDJSON to one UTC-day
segment per file, on by default at `./.sluice/audit`; the Redis list is demoted to a
display cache sized by `SLUICE_AUDIT_CACHE_ENTRIES`. Retention is
`SLUICE_AUDIT_RETENTION_DAYS` (90) rather than a constant, applied on the day boundary
and again on startup so a process that never sees one still enforces it.

Each record carries `seq`, `prevHash` and its own `hash`, so an edit, a deletion or a
reorder breaks the chain and `/audit/verify` says which sequence number it broke at.
Retention deleting a segment is not tampering, so a prune writes a `{ seq, hash }` anchor
to `manifest.json` and a legitimately shortened chain reports `truncated`, not `broken`.
The limit is stated rather than papered over: this catches anyone with write access to
the records, not someone who re-chains the whole directory including the anchor. That
needs the head hash held off-box, which `/api/health` publishes for the purpose.

`/audit` takes `from`, `to`, `destination`, `decision`, `detector`, `userId`, `limit` and
`cursor`, and `format=csv|ndjson` returns the same page as a file with the hashes
attached, so an export can be re-verified instead of taken on trust. A filter it cannot
honour is a `400` rather than a silently unfiltered page — an operator producing evidence
needs to know that `decision=forwaded` narrowed nothing. `sluice verify` and
`sluice export` do the same from the terminal, the former exiting non-zero so it can run
from cron.

Three things were found alongside it:

- **The dashboard asserted health it had never measured.** `App.tsx` rendered "System
  Healthy" and "Redis: Connected" as literal strings whatever the proxy was doing, and
  computed a Coverage percentage as `rules.length / 50` — a denominator corresponding to
  nothing. `/health` was no better: it answered `ok` unconditionally. There is now a real
  storage round trip behind both, `/api/health` reports what the sink actually holds and
  how far back, and the Coverage tile is gone rather than replaced. In a product whose
  value is that its reporting is derived, an operator surface that asserts is the same
  defect as an audit built from a rule's declarations.
- **Fail-closed did not cover the evidence.** Storage, parse and consent failures all
  resolved to not forwarding, but a sink that could not write did not. It does now:
  `evidenceAvailable()` is checked before the forward, and the check initialises the sink
  rather than waiting for a write to fail, so the very first request through a broken
  configuration is refused rather than the second. `SLUICE_AUDIT_REQUIRED=false` reverts
  it; no sink configured is a choice and never blocks.
- **`/api/debug/reset` deleted the evidence.** It now clears the display cache and
  metrics and leaves the sink alone. A record whoever holds the admin token can delete
  proves nothing about what happened.

Still open: `/api/rule-health` joins the audit against `RuleManager.getAllRules()`, which
only iterates `REGISTRY_KEYS`, so an override for an id the registry does not know gets
no health row — `StorageProvider` cannot enumerate keys. And a query reads one day's
segment whole, which is fine at the traffic this is built for and not at ten times it.

## Non-goals

Restated from `CLAUDE.md` because this is where they get argued with: no consent UI,
no CDP, no evasion features, no multi-tenancy. A request that implies one of these
gets raised with the user before any code is written.

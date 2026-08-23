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

### 4. Close the interception holes — **done**

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

Carried out in item 8: **stop minting a persistent `cuid` cookie before consent exists**.
It needed a session-scoped identifier promoted to a persistent one only on a consent
grant, which touches the server's identity resolution and the consent gate — an identity
change, not an interception one.

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

### 6. Make the registry honest — **done**

`adapters/index.ts` registered exactly one adapter. Five other destinations were listed
in the registry and could not forward to their real vendor — `facebook.ts` carried a
literal `<PIXEL_ID>` in its `upstreamUrl`. A registry that lists destinations it cannot
serve is the same class of dishonesty as the audit bug in item 1.

Reading the code first turned out to matter, because "which of these actually work" was
not what anyone had assumed, and it was wrong in both directions:

- **facebook_pixel and amplitude already worked.** A Meta pixel is a bodyless `GET`
  whose whole payload is the query string, so item 4's pixel branch plus item 3's
  `scrubUrl` is a complete scrub of it. Amplitude POSTs its HTTP V2 envelope to the
  endpoint the browser targeted, and the rule's paths address that shape. Calling either
  one unsupported would have been the same dishonesty pointing the other way.
- **mixpanel was leaking.** Its beacon base64-encodes the batch into a `data` parameter.
  Neither pass can see inside that, so the payload was forwarded verbatim and audited as
  `forwarded` with no transformations — accurate, and a leak.
- **facebook_pixel's match keys had never fired.** `data.*.user_data.em` addresses the
  CAPI body; the browser pixel sends `ud[em]` in a query string. Item 8 landed the
  `match_key` mode against paths nothing could reach, so the value scan caught the
  address instead and pseudonymised it — correct policy, and a digest Meta cannot match.
  The event arrived and attributed to nobody, which is the failure the modes exist to
  prevent.
- **amplitude's rule stripped `api_key`**, which is Amplitude's own authentication for
  the call being made and a public client key that ships in the page regardless. Every
  forward that rule produced was rejected by the vendor.

So the support level is now derived from two facts rather than asserted from one.
`transport` on the destination rule states how the vendor's beacon carries its payload —
`pixel` (the query string), `json` (a body at the endpoint the browser targeted), or
`opaque` (encoded, unreadable to both passes). `destinations/support.ts` combines that
with whether an adapter is registered:

| Destination      | transport | support       |
| ---------------- | --------- | ------------- |
| `ga4`            | `pixel`   | `adapter`     |
| `facebook_pixel` | `pixel`   | `adapter`     |
| `mixpanel`       | `opaque`  | `adapter`     |
| `amplitude`      | `json`    | `passthrough` |
| `tiktok`         | `json`    | `passthrough` |
| `hotjar`         | `opaque`  | `unsupported` |

`transport` is required rather than defaulted, so an override written against the older
schema fails to parse and falls back to the registry — the documented behaviour for a
malformed override, and it fails closed to the reviewed value where a default would have
quietly answered the question. `getDefaultRule` declares `opaque`, so a destination
nobody declared is refused by support as unconditionally as its `unknown` category is
refused by consent.

**`unsupported` is a refusal, not a label.** `/ingest` blocks it before anything is
built and audits `destination_unsupported`. That is what closes the Mixpanel class of
leak mechanically: a payload that cannot be scrubbed is not one that gets forwarded.

Two adapters were written. **Meta CAPI** translates the pixel query string into the
Conversions API envelope — which is the shape `facebook.ts`'s paths already addressed, so
its `em` and `ph` match keys fire for the first time. It populates
`client_ip_address` and `client_user_agent` from what actually reached the proxy
specifically so the rule visibly removes them: "no raw IP reached Meta" belongs in the
audit as evidence rather than as an omission. **Mixpanel** decodes the `data` parameter,
scrubs the batch, and posts it to the server-side ingestion endpoint; the project token
rides in `properties.token`, so it needs no configuration, which is why an unconfigured
deployment gets real protection there rather than a skip.

The remaining three stay in the registry. Deleting an entry also drops the client's
interception pattern, so a deleted vendor's beacons reach it unscrubbed — strictly worse
than an honest `unsupported` that is intercepted and refused. Hotjar is that case: what
it sends is a recording envelope, its rule's `payload.data.form_fields.*.value` path
could never have matched it, and it now blocks rather than pretending.

Three things were found alongside it:

- **Destination matching was `url.includes(domain)` against the whole URL.** So
  `https://app.example.com/?ref=amplitude.com` was rerouted into the firewall and
  `notamplitude.com` matched `amplitude.com`. Losing real first-party application
  traffic to an analytics proxy is the expensive half of that. `matchDestination` moved
  into `client/src/patterns.ts` and now parses the URL and reads the host under the same
  subdomain rule `engine/egress.ts` applies server-side, with an optional path prefix
  that has to match whole segments. The drift guard imports that function rather than
  reimplementing it, and asserts the lookalikes.
- **Two hosts were never intercepted at all.** `api-js.mixpanel.com` is where the JS SDK
  posts and `api.mixpanel.com` was the only pattern; `hotjar.io` carries the recordings
  and only `hotjar.com` was declared.
- **An already-hashed match key was hashed again.** Meta's pixel with Advanced Matching
  hashes `em` and `ph` in the browser, so `applyHash` was producing a digest of a digest:
  well-formed, accepted, matching nobody. It now leaves a value that is already a SHA-256
  digest alone, and writes no audit entry, because nothing fired.

**Item 5's interception holes, closed and restated.** The mutation observer now handles
`<img>` as well as `<script>`, so a pixel the parser appends below the Sluice tag is
rerouted rather than walking past; `srcset` joined `src` on both the property setter and
`setAttribute`, because a candidate list is a list of URLs the browser will fetch one of.
There is deliberately no document-ready sweep behind it: by then every parser-issued
request has completed, so a sweep cannot prevent a leak and would only send the vendor
the same event twice. What is left — an `<img>` or a `window.fetch`-capturing tracker
_above_ the Sluice tag — is not closable in the client at all. It is an install
requirement, and `docs/install.md` now states it as one rather than carrying it
indefinitely as a known gap.

Still open: `/api/rule-health` still only reports destinations the registry knows, and
Amplitude, TikTok and Hotjar still have no adapter. Two of the three do not need one.

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

### 8. Decide what a hash is for — **done**

The one slice where the code and its own comments disagreed. `detectors/patterns.ts`
justified hashing an email rather than stripping it — "Meta and Google both accept a
pre-hashed email for identity resolution, so the event survives without carrying the
address" — while `applyHash` appended a salt. Meta's Conversions API specifies
normalise-then-SHA-256 with no salt, so every hashed `em` and `ph` was a well-formed
digest that matched nobody. The event did not survive; it failed quietly, and the audit
recorded a successful transformation.

Removing the salt was not the fix. A plain SHA-256 of an email is dictionary-recoverable
— hash a candidate list, match the digests — so keyed hashing is what pseudonymisation
actually asks for, and hashed data stays personal data either way. Both positions were
right. They are two jobs, and one function was doing both.

There are now two named modes on the transformation schema. `pseudonymize` is
HMAC-SHA256 under `SLUICE_HASH_SECRET` and is the default. `match_key` is the vendor's
contract — per-vendor normalisation, then unsalted SHA-256 — and is permitted only on a
field a destination rule declares as one, which makes the weaker disclosure a reviewable
line in a rule rather than a global setting. `facebook.ts` declares two: `em` and `ph`.
The value scan always pseudonymises, because a field found by shape at a path nobody
declared has been reviewed by nobody. Normalisation is pinned against Meta's documented
forms in the test suite, so drift fails the gate rather than the campaign, and a match key
whose value will not normalise is stripped rather than hashed — the digest of an empty
string is a constant that would read as a real identity. The audit carries the mode: a
`match_key` entry and a `pseudonymize` entry are materially different disclosures.

Three things were fixed alongside it:

- **The salt defaulted, and was read from the wrong place.** `SLUICE_HASH_SALT` fell back
  to the literal `default-salt`, and `applyHash` read `process.env` rather than the env
  the app was constructed with — so on the Cloudflare Workers provider this repo ships it
  fell through to a second hardcoded literal, `sluice-default-salt-12345`. A published
  default is not a secret: anyone holding this repository could hash a candidate list and
  match it back. There is no default now; outside development a missing
  `SLUICE_HASH_SECRET` is a fatal start-up error naming the variable, in development it is
  minted per process, and `sluice init` writes one into the compose file it generates. The
  hasher is built once at construction rather than reconstructing the whole server config
  per hashed field per request.
- **The identifier was minted before consent existed.** `getOrSetUserId` wrote a 365-day
  cookie and a `localStorage` entry on page load — a persistent tracking identifier stored
  with no consent record anywhere, which is an ePrivacy Art. 5(3) problem in a tool whose
  whole point is compliance. The `localStorage` copy survived the user deleting their
  cookies, and Safari caps a cookie set via `document.cookie` at seven days regardless, so
  the 365-day expiry was fiction there and a real liability everywhere else. The client
  moved to a `sessionStorage` identifier that died with the tab, and the server promotes an
  id to an `HttpOnly` first-party cookie only once a consent record exists, resolving
  identity from that cookie ahead of anything the page says about itself. Item 9 finished
  the job: the client mints nothing at all now.
- **`getDefaultRule` failed open.** It returned `category: 'necessary'`, which `hasConsent`
  grants unconditionally — reachable whenever a rule override exists for an id the registry
  does not know and will not parse. It now returns `unknown`, which `hasConsent` refuses as
  unconditionally as it grants `necessary`, so a CMP configured with a purpose by that name
  cannot re-open the branch.

Carried out in item 9: the client stopped minting an identifier altogether.

### 9. Stop storing anything before consent — **done**

Item 8 left a `sessionStorage` identifier on the visitor's device before any consent
record existed. The open question was whether the firewall's own routing identifier is
strictly necessary under ePrivacy Art. 5(3) — which is technology-neutral, so
`sessionStorage` was covered by it exactly as a cookie is, and "it is not a cookie" was
never the defence. There is a real exemption to argue: WP29 Opinion 04/2012 treats storage
holding a user's consent preferences as exempt, since the alternative is re-asking on every
page load.

The argument did not survive checking what the identifier did. Consent records are keyed by
the subject id an external CMP sends over `/webhooks/:provider`. The client minted a random
UUID. Those never coincide, so on a stock install every request was refused for want of
consent, `consent._exists` was never true and the cookie was never promoted, and the id's
entire contribution was naming the audit row of a request that was blocked anyway. It was
not strictly necessary because it was not sufficient.

So it is gone. Identity comes from `config.userId` — the subject the page's CMP knows — or
from the server's own `HttpOnly` cookie, and from nowhere else. A visitor whose CMP has not
spoken reaches the firewall with no identity, is refused, and has nothing written to their
device. The outcome is what it always was; the storage is not.

One thing was found alongside it. **A request with no identity left no record.** It was
counted and dropped with a bare `204`, which after this change is the ordinary path for
every pre-consent visitor rather than an edge case — the same defect item 10 closed for an
unknown destination. It is now audited as `no_identity` against a constant `(anonymous)`
subject. The subject is a constant deliberately: deriving one from the request would be the
server minting the identifier the client just stopped minting.

Still open: the wiring this exposed. `docs/install.md` lists `userId` as an option to "pin
the identifier", when it is in fact what makes the consent gate function at all. A stock
install forwards nothing and does not say why.

### 10. Say what happened to a request nobody can serve — **done**

`/ingest` refused a destination no rule describes with a bare `400`, writing no audit
record and no metric — the one decision on the path that left nothing behind, against an
invariant that says every decision is appended to a durable sink. The case that matters is
not a mistyped path but a browser still running a bundle from before a registry change,
whose beacons are dropped by a firewall that cannot say it dropped them. It is now audited
as `unknown_destination`. The status stays `400` rather than the opaque `204`: this is an
integration mistake, and the developer making it benefits from being told.

`ClientConfig.domains` went with it. It mapped an arbitrary host to the destination id
`unknown`, which no rule describes, so every request it produced was refused and discarded
— a documented option whose only effect was to drop the traffic it was asked to protect.
Extending coverage means a destination rule; blocking a host by name is not something this
firewall claims to do.

### 11. Scrub a value that arrived as a number — **done**

Three of the four transformation primitives gated on `typeof value === 'string'`, so the
firewall's protection depended on a payload's JSON types — a boundary no vendor treats as
one. A declared `hash` on a numeric `user_id` did nothing and wrote no audit entry, and
`ga4`, `amplitude` and `mixpanel` all declare that path while all three vendors accept the
field as a number. The record was honest and the reading it invited was wrong: rule health
showed `matched: 0`, which reads as a dead path rather than as an identifier leaving in the
clear.

`asScalarText` now states the rule once. A number is transformed as its decimal text; a
boolean is not an identifier, and an object or array is a rule pointing at a container
rather than a field, which stays visible as `matched: 0` instead of being quietly hashed.

The value scan reads numbers too, and the reason it is safe is narrow: five of the six
detectors need punctuation and cannot fire on a digit run at all. `credit_card` can, and a
16-digit card is a safe JSON integer — so `{"pan": 4111111111111111}` round-tripped intact
while the same value in quotes was stripped. Luhn plus an issuer prefix is what keeps it
off ordinary ids; no prefix begins with `1`, so a millisecond or microsecond timestamp
cannot match however its check digits fall.

### 12. Verify one destination properly — **done**

Every slice before this improved a mechanism. None of them established that the mechanism
protects any particular vendor: Amplitude's and TikTok's paths were written from vendor
documentation, and nothing asserted that a declared path exists in a payload the vendor
really sends. `/api/rule-health` was built to answer exactly that and had never been
pointed at traffic. That is the difference between "the firewall works" and "the firewall
protects these six vendors", and only the second one is a claim.

Rather than cut the registry to GA4, the verification effort was cut to GA4. Deleting a
destination also deletes its interception pattern, so a deleted vendor's beacons stop being
intercepted and go out unscrubbed — strictly worse, and already settled in item 6. And the
value scan is vendor-independent: email, phone, address and card are caught by shape in any
JSON payload whatever the declared paths say, so the other five are not unprotected, their
precision layer is unproven.

`adapters/ga4.fixtures.ts` writes out the `/g/collect` wire format parameter by parameter,
and `ga4.verify.test.ts` asserts the sentence end to end against it: nothing reaching Google
carries an email, a phone number, an address or a card, across every fixture. Three things
came out of it.

- **The adapter is an allowlist, and nobody had said so.** Only `ep.`/`epn.` event
  parameters and five named context keys are copied into the Measurement Protocol payload.
  Everything else gtag sends — `up.` user properties, session counters, client hints — is
  dropped. A site putting an address in `user_properties` sends it on every single hit, and
  the allowlist closes that for fields nobody thought to declare as much as for the ones
  they did. It is the strongest privacy property this destination has and it was implicit
  in a loop.
- **The visitor's address never reaches Google, by construction.** The Measurement Protocol
  call is made by the proxy, so the connection Google sees is the deployment's. The only
  way the visitor's could travel is `uip`, which the adapter never sets. True before this
  change, asserted only after it.
- **A batched hit was being turned into an event that never happened.** gtag queues events
  and posts them as CRLF-separated lines with the shared context left in the query string.
  The body was handed to `URLSearchParams` whole, so splitting on `&` ran through the line
  breaks and merged three events into one: a `page_view` carrying a purchase's value and a
  `dl` with a literal newline in it. No personal data escaped — the email still met the
  rule — but the vendor was sent a fabricated event, which in a tool whose product is that
  its reporting is derived from what occurred is the same defect as an audit built from a
  rule's declarations. Events are now parsed one per line, each keeping its own page.

Two declared paths could not be made to fire. `events.*.params.ip` now does, against a
beacon carrying `ep.ip`. `events.*.params.uip` does not: reaching it needs a site to name an
event parameter `uip`, which gtag does not do on its own. It is kept and named in a
`DEFENSIVE` list with its reason, and the suite asserts that list holds nothing the rule has
stopped declaring and nothing that does in fact fire — so it cannot become a place to hide a
dead rule. Padding the fixtures with a beacon nobody sends would have made the suite pass
while proving nothing.

Two placeholders went at the same time, defects at any scope. `tiktok.ts` declared
`properties.content_id` → redact `ID-[0-9]+`, commented "Example of redact with pattern" —
demo scaffolding in a live rule — and hashed `context.ip`, contradicting the policy stated
in `detectors/patterns.ts` that an address is stripped because a hash of one is still a
stable household identifier. And `getDefaultRule` declared three transformations behind an
`opaque` transport that the support gate refuses before anything is scrubbed, so none of
them could ever run.

Still open: the fixtures are the documented wire format written out, not captures from a
live browser, so they verify the rule and the adapter against the format rather than against
a recording. Replacing them with real captures is a strict improvement and needs no other
change. And the other five destinations remain unverified.

### 13. Decide what the record itself discloses — **done**

Every sealed record carried the CMP's subject id in the clear, for ninety days, in an
append-only chain built to make deletion detectable. That is the one place where the two
halves of the product pull against each other, and the repository had no stated position.

Most of the tension turned out to be misread. The subject id is already pseudonymous — it
is never a name or an address, and the values the firewall removes are deliberately never
recorded. Retention is bounded by `SLUICE_AUDIT_RETENTION_DAYS`. And an audit proving that
personal data did not reach a vendor sits close to the centre of Art. 17(3)(e), defence of
legal claims, and of the accountability duty in Art. 5(2); records kept to demonstrate
compliance are ordinarily retained through an erasure request. More to the point, the
subject is what lets the record answer a _subject access_ request — `/audit?userId=` is how
an operator tells a data subject what happened to their data. Removing it would have made
the record less useful to the person it is about.

What was worth fixing was narrower, and it is not erasure. **The record is exported.**
`/audit?format=csv` and `sluice export` produce files that go to auditors and regulators,
and those carried subject ids. `AuditLogger` now seals an HMAC of the subject under
`SLUICE_HASH_SECRET`, and hashes a `userId` filter the same way before matching — so the
question an operator asks is unchanged, the stored and exported form is not. `(anonymous)`
stays a literal, because it names the absence of an identity rather than one being withheld,
and a digest of a constant would say the same thing less clearly.

The limit is worth stating plainly, because it is easy to overclaim: a keyed pseudonym is
still personal data under Recital 26, and the deployment holds the key. This reduces what a
leaked or shared audit directory exposes. It does not discharge an erasure obligation. The
option that would — sealing the hash and keeping a separate, deletable mapping — costs a new
store, an erasure endpoint and a lookup on every read path, and is not worth it at this
size. The cost paid here is legibility: the dashboard and `sluice logs` now print a digest.

**A second writer was corrupting the chain silently.** `FileAuditSink` serialises appends
through an in-process promise chain, which makes it correct for one process and says nothing
about a second. Two containers on one mounted volume each seal against their own in-memory
head, claim the same sequence numbers, and interleave into a chain that does not verify —
and nothing noticed until somebody happened to run `sluice verify`, which for the artefact
this product sells is the wrong time to find out. The sink now records the size it left the
segment at and checks it before each append: a segment that changed underneath it is refused
rather than appended on top of, `healthy()` goes false, and the evidence gate stops
`/ingest` forwarding. It catches a hand-edited file as readily as another process, and a
restart still adopts what it finds, because the check is for a concurrent writer and not for
a directory that has been written to before. A lock was considered and rejected: it would
have introduced a stale-lock failure mode — a crashed container leaving a lock that stops
the next one starting — in exchange for preventing a condition this detects.

## Non-goals

Restated from `CLAUDE.md` because this is where they get argued with: no consent UI,
no CDP, no evasion features, no multi-tenancy. A request that implies one of these
gets raised with the user before any code is written.

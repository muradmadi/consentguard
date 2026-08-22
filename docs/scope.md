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

### 1. Fix the evidence, because the evidence is the product

`app.ts` computes the audit trail as:

```ts
const transformationsApplied = rule.transformations?.map((t) => `${t.action}:${t.path}`) || []
```

That is the rule's _declared_ transformation list, not what actually fired. A request
carrying no personal data at all is logged as `decision: 'scrubbed'` with a full list of
transformations that matched nothing. The one artifact the whole product rests on
currently overstates what it did.

`scrubPayload` must return what it changed — path, action, and whether the path was
present — and the audit record must reflect only that. `decision` becomes `'scrubbed'`
only when at least one transformation actually matched.

### 2. Detect personal data that was not declared

Today a field is only scrubbed if someone wrote its exact dotted path into a rule. That
catches known leaks and nothing else, which is the weaker half of the problem — the
expensive incidents are the fields nobody knew were being sent.

Add a scanning pass that walks the whole payload and matches _values_, not paths:
email, E.164 and common national phone formats, IPv4/IPv6, credit-card numbers (Luhn),
and national identifiers behind an opt-in flag. Each detector gets its own action and
its own audit entry. Declared rules stay as the precise, cheap layer on top.

This is the feature that makes the product a firewall rather than a config file. It is
the highest-value work in this document.

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

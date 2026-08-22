# Sluice

Sluice is a **PII firewall for analytics traffic**. A web app's analytics and marketing
requests are routed through it; it strips personal data out of the payload before
forwarding to the vendor, and records what it removed.

The claim is not "we block trackers" and not "we manage consent". It is:

> Nothing leaves your infrastructure carrying an email, a phone number, or a raw IP,
> and there is a per-request record proving it.

Everything in this repo is judged against that sentence. If a change does not make
that sentence more true, more provable, or easier to operate, it is out of scope.

## Scope

**In scope**

- Detecting personal data in outbound analytics payloads — both at paths a rule
  declares and by the shape of the value, wherever it turns up.
- Transforming it — `strip`, `hash` (salted SHA-256), `redact` (regex) — per destination rule.
- Forwarding the cleaned payload to the vendor's server-side API.
- An audit record of every transformation applied to every request.
- The minimum proxy + browser interceptor needed to get requests into the firewall.

**Out of scope.** These are deliberate non-goals, not gaps. Raise it with the user
before building any of them, even if a request seems to imply one:

- **Consent banners or a CMP.** Consent arrives from an external CMP over
  `/webhooks/:provider` and is only an input to an allow/deny gate. We do not
  render UI, collect consent, or compete with OneTrust/Cookiebot/Usercentrics.
- **Being a CDP or an analytics product.** We do not store events, model users,
  build funnels, or offer a query layer. Payloads pass through; only audit
  metadata is retained.
- **Ad-blocker, ITP, or tracking-prevention evasion.** The architecture (first-party
  endpoint, first-party cookie, server-side forwarding) is mechanically identical to
  the evasion playbook. That makes the distinction a matter of intent, so it has to be
  defended in code: defaults stay privacy-preserving, and no feature ships whose
  primary value is making tracking survive a user's stated preference.
- **Multi-tenancy, accounts, billing, hosted service.** Single-tenant, self-hosted.

See `docs/scope.md` for the in-flight cut-list that brings the current code in line
with the above.

## Architecture

Five workspace packages under `packages/`, built by turbo, orchestrated by `just`.

| Package          | Role                                                               |
| ---------------- | ------------------------------------------------------------------ |
| `@sluice/shared` | Zod schemas shared by every other package. The contract.           |
| `@sluice/server` | The firewall itself: Hono app, rules, transformer, audit, storage. |
| `@sluice/client` | Browser interceptor that reroutes vendor requests to the proxy.    |
| `@sluice/admin`  | React dashboard served at `/dashboard`. Read-mostly.               |
| `@sluice/cli`    | `sluice` binary: init, start, status, logs.                        |

### The request path

`POST /ingest/:destination` in `packages/server/src/app.ts` is the hot path. In order:

1. **Origin check** — `requireAllowedOrigin`. Not in `SLUICE_ALLOWED_ORIGINS` → `403`.
   An empty allowlist is permissive; that is a dev-only default. A non-empty one
   requires the header: a request that will not say where it is from is not on the list.
2. **Identity** — `X-Consent-UserId` header, then `cuid` cookie, then `?cuid=`,
   then `?sluice_user_id=`. No identity → `204`.
3. **Destination known?** — `RuleManager.isSupported`. Unknown → `400`.
4. **Body read once**, capped at `SLUICE_MAX_BODY_BYTES` (64 KiB default), into
   `rawBody` + `jsonBody` (vendors like GA4 send form-encoded). Over the cap → `413`.
   `Content-Length` is a claim, so the stream is counted as it arrives.
5. **Consent gate** — `ConsentManager.hasConsent(consent, rule.category)`. Denied →
   blocked (`204`).
6. **Evidence gate** — `auditLogger.evidenceAvailable()`. A durable audit sink that
   is configured and cannot write means a forward could not be evidenced, so it is not
   made: blocked (`204`) with `evidence_unavailable`. Off with `SLUICE_AUDIT_REQUIRED=false`;
   no sink configured is a choice, not a failure, and does not block.
7. **Scrub + build** — a registered `VendorAdapter` translates the intercepted beacon
   into the vendor's server-side schema and calls `scrubPayload` itself. With no
   adapter, a generic JSON passthrough scrubs and forwards to `rule.upstreamUrl`.
   `scrubPayload` applies the rule's declared paths and then the value scan; both
   produce audit entries, and a scan entry carries the `detector` that found it.
   `buildForward` then puts the resulting URL through `scrubUrl`, so the query string
   is scrubbed by the same two passes as the body. Its audit entries are prefixed `?`.
   A bodyless request with an original URL is a pixel: its whole payload is the query
   string, so it forwards as a `GET` to that URL and `scrubUrl` alone is a complete
   scrub. `unscrubbable_payload` therefore means a body that exists and will not parse.
8. **Egress check** — `checkEgress` on the URL that will actually be fetched. Its host
   must be one the destination rule declares, and must not be an internal address.
   Refused → `blocked` with the reason in the audit.
9. **Forward upstream** with `redirect: 'manual'`, then audit + metrics. Success → `204`,
   upstream failure → `502`. The audit is written after the upstream call resolves, so
   `decision` states what happened rather than what was intended.

### Where things live

- **Transformation engine** — `engine/transformer.ts` walks a dotted path with `*` as an
  array wildcard, dispatching to `engine/transformations/{strip,hash,redact}.ts`. Each
  primitive returns whether it fired; `scrubPayload` returns `{ payload, report }`.
- **Value scan** — `engine/detectors/patterns.ts` defines the detectors (email, phone,
  ipv4, ipv6, credit_card, and opt-in us_ssn) and `detectors/scan.ts` walks every string
  in the payload applying them. `scrubPayload` runs it after the declared pass, so a field
  a rule already hashed is not re-detected. Configured by `SLUICE_DETECTORS`; `off`
  disables it.
- **Egress allowlist** — `engine/egress.ts` decides whether a forward may be made at all.
  `?original=` and `X-Original-Url` are attacker-controlled, so the destination rule is
  the authority: a forward's host must match an endpoint the rule declares (domain half
  only — the path addresses the vendor's API) or the host of its `upstreamUrl`. Internal
  addresses are refused ahead of the allowlist, so a rule cannot declare its way to one.
  It reads the parsed hostname, not the URL string; it does not resolve DNS, so a declared
  domain pointing at a private address still passes, which needs rule-write access.
- **URL scrub** — `engine/url.ts` runs the query string of an outbound URL through
  `scrubPayload`, treating each parameter as a field. A beacon carries as much personal
  data there as in its body, and the passthrough forwards to the URL the browser
  originally targeted. The path is left alone: it addresses the vendor's API rather than
  carrying payload.
- **Forward builder** — `buildForward` in `app.ts` turns a request into the scrubbed
  upstream call. `routeForward` picks the adapter, pixel, or passthrough shape;
  `buildForward` then scrubs the URL and runs the egress check over whatever came back —
  an adapter's own URL included — so scrub-before-egress and only-where-the-rule-says
  each live in exactly one place.
- **Destination rules** — `destinations/<vendor>.ts`, registered in `destinations/registry.ts`.
  A rule is declarative: `id`, `category`, `endpoints`, optional `upstreamUrl`, `transformations[]`.
- **Vendor adapters** — `destinations/adapters/<vendor>.ts`, registered in `adapters/index.ts`.
  Only needed when the vendor's server-side API differs in shape from what the browser sent.
- **Interception patterns** — `packages/client/src/patterns.ts` maps a domain substring to a
  destination id. It must stay in sync with the server registry, and
  `server/src/destinations/patterns.test.ts` enforces both halves: no pattern may name a
  destination the registry lacks, and no rule endpoint may go unmatched. That suite is
  excluded from the server's `typecheck` — it imports across a package boundary, which
  `rootDir` rejects.
- **Audit sink** — `engine/audit/` is the record. `sink/file.ts` writes NDJSON to disk,
  one UTC-day segment per file, never rewritten; `chain.ts` seals each record with the
  digest of the one before it; `query.ts` holds the one filter predicate every reader
  uses; `export.ts` renders CSV and NDJSON; `rule-health.ts` derives which declared
  transformations have actually fired. The Redis list is demoted to a display cache
  sized by `SLUICE_AUDIT_CACHE_ENTRIES`. `createApp` takes the sink as an argument so
  the app never imports `node:fs`; `src/index.ts` builds it.
- **Storage** — `engine/storage/` provides memory, redis, and cloudflare-kv behind one
  `StorageProvider` interface, with `hybrid.ts` as an in-process cache wrapper.

### Audit configuration

| Variable                      | Default           | Meaning                                                                 |
| ----------------------------- | ----------------- | ----------------------------------------------------------------------- |
| `SLUICE_AUDIT_DIR`            | `./.sluice/audit` | Where the durable record is written. Empty disables it.                 |
| `SLUICE_AUDIT_RETENTION_DAYS` | `90`              | How long segments are kept before they are pruned and anchored.         |
| `SLUICE_AUDIT_REQUIRED`       | `true`            | A configured sink that cannot write stops `/ingest` forwarding.         |
| `SLUICE_AUDIT_CACHE_ENTRIES`  | `1000`            | Size of the display cache in front of the sink. Not a retention policy. |
| `SLUICE_RULE_HEALTH_SCAN`     | `20000`           | Ceiling on the scan `/api/rule-health` derives its counts from.         |

Deploying in a container means mounting a volume at `SLUICE_AUDIT_DIR`. Without one the
record dies with the container, and `SLUICE_AUDIT_REQUIRED` will not catch it — the sink
is writable, it is just ephemeral.

### Invariants

- **Fail closed.** Storage errors, parse errors, and missing consent all resolve to
  _not forwarding_. `ConsentManager.getConsent` returns a deny-by-default state on any
  failure. Never add a code path that forwards on error.
- **Opaque 204.** The caller always sees a clean `204`, whether the request was
  forwarded, scrubbed, or dropped. Vendor SDKs must not be able to detect enforcement,
  or they retry and degrade. `dangerouslyAllowOnError` is the single documented escape
  hatch and stays off by default.
- **Scrub before egress, always.** No path may `fetch` a vendor with a payload that has
  not been through `scrubPayload` or an adapter that calls it. That covers the URL as
  well as the body — a query string is payload. A body that cannot be parsed cannot be
  scrubbed, so it is blocked rather than forwarded.
- **Egress only where the rule says.** The firewall calls hosts a destination rule
  declares and nothing else, and does not follow redirects. The caller names a URL; it
  does not choose one.
- **No secret in a shipped artifact.** The dashboard is served unauthenticated, so the
  admin bearer is entered at runtime and held in session storage. Never read it from a
  build-time `VITE_*` variable. `just check-dist` fails the gate on anything
  secret-shaped in `packages/*/dist`.
- **The record outlives the process.** Every decision is appended to a durable sink
  before the display cache sees it, and the sink is never rewritten — `/api/debug/reset`
  clears the cache and leaves the evidence. Retention deletes whole day segments and
  writes a `{ seq, hash }` anchor to `manifest.json` so a legitimately shortened chain
  still verifies. The chain detects an edit, a deletion or a reorder by anyone with
  write access to the directory; it does not detect someone who re-chains the whole
  directory including the anchor, which is why `/api/health` publishes the head hash for
  anchoring off-box.
- **Health is measured, never asserted.** `/health` and `/api/health` report a real
  storage round trip and real sink counts. No operator surface may state a fact it did
  not obtain from the proxy — that is the same defect as an audit built from a rule.
- **The audit is derived, never declared.** `transformations` comes from the `ScrubResult`
  report — an entry means that transformation actually changed this payload. Never build
  it from `rule.transformations`, and never record the removed value.

## Working in this repo

`just` is the only entry point you need. `just` with no arguments lists everything.

```
just check     # THE GATE: lint, fmt-check, typecheck, build, check-dist, test. Must pass before commit.
just test      # tests only
just watch server   # re-run one package's tests on change
just dev       # everything in watch mode
just serve     # run the built proxy on :3000 with in-memory storage
```

Run `just check` and report its real output. Never claim a change works without it.

### Constraints that will bite you

- **`bunfig.toml` pins `linker = "hoisted"`.** Bun 1.4 defaults to an isolated linker,
  under which Vite 8 cannot resolve `rolldown` at runtime and the client/admin builds
  fail. Do not remove or change this.
- **TypeScript is pinned at 6.0.3.** typescript-eslint 8 caps at `<6.1.0`. Do not bump
  TypeScript until that cap lifts.
- **Declarations are emitted by `tsc`, not tsup.** tsup's DTS worker injects the
  `baseUrl` option, which TS 6 rejects (`TS5101`). Build scripts run
  `tsup && tsc -p tsconfig.build.json --emitDeclarationOnly`. `tsconfig.build.json`
  exists purely to keep `*.test.ts` declarations out of `dist` while `typecheck`
  still covers them.
- **`turbo.json` has `typecheck.dependsOn: ["^build"]`.** Without it, packages
  typecheck before their dependencies emit `.d.ts` and fail on a cold clone.
- **Vitest, not `bun test`.** The client suite depends on `vi.resetModules()` plus
  dynamic re-import to get a fresh interceptor patch per test, and on the `jsdom`
  environment. Bun's runner has no equivalent.
- **`prettier --check .` covers Markdown.** Format docs too, or the gate fails.
- **`no-explicit-any` is off deliberately.** Destination adapters handle untyped
  third-party payloads. Don't turn it on; don't add `any` outside that boundary either.

### Conventions

- Prettier: no semicolons, single quotes, trailing commas, 100 columns.
- Tests live beside their subject as `*.test.ts`. Every new test suite gets
  mutation-checked — break the source, confirm the test fails, restore.
- Commits: imperative, one line, describing the behavior change. No `feat:`/`chore:`
  prefixes, no scopes, no file lists. Work on `main`; commit only when asked.
- Match the surrounding comment density. Comments explain _why_, not _what_.

## Known gaps

Real, verified, and unfixed. Do not re-diagnose these from scratch:

- **An `<img>` in the initial HTML is not intercepted.** The interceptor patches the
  `HTMLImageElement.prototype.src` setter and `setAttribute`, which covers every pixel
  built in script. A pixel already in the served markup has its `src` set by the parser
  and never reaches either. `srcset` is not covered at all.
- **Load-order fragility.** A tracker that captures `window.fetch` before the Sluice
  bundle executes keeps the unpatched reference. Scripts above the Sluice tag in the
  initial HTML are never neutralized.
- **The `cuid` cookie is set before any consent exists.** `getOrSetUserId` writes a
  365-day cookie and a `localStorage` entry on page load. Storing a persistent
  tracking identifier without consent is an ePrivacy Art. 5(3) problem in a tool
  whose whole point is compliance.
- **One real adapter.** `adapters/index.ts` registers GA4 and nothing else. The other
  five registry entries fall through to generic JSON passthrough; `facebook.ts` has a
  literal `<PIXEL_ID>` placeholder in its `upstreamUrl` and cannot work.
- **Rule health only covers destinations the registry knows.** `/api/rule-health` joins
  the audit against `RuleManager.getAllRules()`, which iterates `REGISTRY_KEYS`. An
  override for an id the registry lacks gets no health row, because `StorageProvider`
  cannot enumerate keys.
- **A day's segment is read whole.** `FileAuditSink.query` loads one UTC-day file at a
  time. Fine at the traffic this is built for; a very high-volume day is a large read.
- **`getDefaultRule` returns `category: 'necessary'`**, which `hasConsent` always
  grants. Reachable when a malformed rule override exists for an id the registry does
  not know. Fail-open in a fail-closed system — though it now forwards nowhere, because
  the rule declares no endpoints and the egress check refuses everything.
- **The egress check does not resolve DNS.** A destination rule that declares a domain
  which resolves to a private address still reaches it. Closing that needs a resolver on
  the hot path; reaching it needs the ability to write destination rules.

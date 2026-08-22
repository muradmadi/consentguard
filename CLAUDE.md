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

- Detecting personal data in outbound analytics payloads.
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
   An empty allowlist is permissive; that is a dev-only default.
2. **Identity** — `X-Consent-UserId` header, then `cuid` cookie, then `?cuid=`,
   then `?sluice_user_id=`. No identity → `204`.
3. **Destination known?** — `RuleManager.isSupported`. Unknown → `400`.
4. **Body read once** into `rawBody` + `jsonBody` (vendors like GA4 send form-encoded).
5. **Consent gate** — `ConsentManager.hasConsent(consent, rule.category)`. Denied →
   buffer (`202`) if the user has no consent record and `BUFFER_PENDING` is on,
   otherwise blocked (`204`).
6. **Scrub + build** — a registered `VendorAdapter` translates the intercepted beacon
   into the vendor's server-side schema and calls `scrubPayload` itself. With no
   adapter, a generic JSON passthrough scrubs and forwards to `rule.upstreamUrl`.
7. **Forward upstream**, then audit + metrics. Success → `204`, upstream failure → `502`.
   The audit is written after the upstream call resolves, so `decision` states what
   happened rather than what was intended.

### Where things live

- **Transformation engine** — `engine/transformer.ts` walks a dotted path with `*` as an
  array wildcard, dispatching to `engine/transformations/{strip,hash,redact}.ts`. Each
  primitive returns whether it fired; `scrubPayload` returns `{ payload, report }`.
- **Forward builder** — `buildForward` in `app.ts` turns a request into the scrubbed
  upstream call. Both the live path and buffer replay go through it, so the scrub-before-egress
  rule lives in one place.
- **Destination rules** — `destinations/<vendor>.ts`, registered in `destinations/registry.ts`.
  A rule is declarative: `id`, `category`, `endpoints`, optional `upstreamUrl`, `transformations[]`.
- **Vendor adapters** — `destinations/adapters/<vendor>.ts`, registered in `adapters/index.ts`.
  Only needed when the vendor's server-side API differs in shape from what the browser sent.
- **Interception patterns** — `packages/client/src/patterns.ts` maps a domain substring to a
  destination id. This must stay in sync with the server registry.
- **Storage** — `engine/storage/` provides memory, redis, and cloudflare-kv behind one
  `StorageProvider` interface, with `hybrid.ts` as an in-process cache wrapper.

### Invariants

- **Fail closed.** Storage errors, parse errors, and missing consent all resolve to
  _not forwarding_. `ConsentManager.getConsent` returns a deny-by-default state on any
  failure. Never add a code path that forwards on error.
- **Opaque 204.** The caller always sees a clean `204`, whether the request was
  forwarded, scrubbed, or dropped. Vendor SDKs must not be able to detect enforcement,
  or they retry and degrade. `dangerouslyAllowOnError` is the single documented escape
  hatch and stays off by default.
- **Scrub before egress, always.** No path may `fetch` a vendor with a payload that has
  not been through `scrubPayload` or an adapter that calls it. A body that cannot be
  parsed cannot be scrubbed, so it is blocked rather than forwarded.
- **The audit is derived, never declared.** `transformations` comes from the `ScrubResult`
  report — an entry means that transformation actually changed this payload. Never build
  it from `rule.transformations`, and never record the removed value.

## Working in this repo

`just` is the only entry point you need. `just` with no arguments lists everything.

```
just check     # THE GATE: lint, fmt-check, typecheck, build, test. Must pass before commit.
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

- **`<img>` pixels are not intercepted.** `packages/client/src/index.ts` patches `fetch`,
  `XMLHttpRequest`, and `sendBeacon` only. `new Image().src = ...` is the primary
  transport for the Meta pixel and much of ad-tech, and it walks straight past.
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
- **`getDefaultRule` returns `category: 'necessary'`**, which `hasConsent` always
  grants. Reachable when a malformed rule override exists for an id the registry does
  not know. Fail-open in a fail-closed system.
- **`init()` is not idempotent.** Calling it twice double-wraps `fetch`.

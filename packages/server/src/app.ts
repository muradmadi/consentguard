import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { ConsentStateSchema, DestinationRuleSchema, PiiDetectorSchema } from '@sluice/shared'
import { ConsentManager } from './engine/consent'
import { scrubPayload } from './engine/transformer'
import { createHasher } from './engine/transformations/hash'
import { scrubUrl } from './engine/url'
import { metrics } from './engine/metrics'
import {
  AuditLogger,
  deriveRuleHealth,
  toCsv,
  toNdjson,
  type AuditQuery,
  type AuditSink,
} from './engine/audit'
import { checkEgress } from './engine/egress'
import { RuleManager } from './engine/rules'
import { createWebhookRouter } from './webhooks/cmp'
import { StorageProvider, HybridStorageProvider } from './engine/storage'
import { getServerConfig, ServerConfig } from './config'
import { getAdapter, VendorContext, VendorForward } from './destinations/adapters'
import { supportFor, withSupport } from './destinations/support'

/**
 * The one persistent identifier Sluice writes, and only after a consent record
 * exists for the id it names. The client mints a session identifier for itself
 * and sends it in a header or a query parameter; this cookie is the server
 * promoting one of those, which is why it outranks both when identity is
 * resolved.
 */
const IDENTITY_COOKIE = 'cuid'

export interface AppOptions {
  /**
   * Where the durable audit record is written. Passed in rather than built
   * here: the sink that ships is backed by a filesystem, and this app has to
   * run on runtimes that have none.
   */
  auditSink?: AuditSink
}

export function createApp(storage: StorageProvider, env: any = {}, options: AppOptions = {}) {
  const app = new Hono()
  const config = getServerConfig(env)

  const effectiveStorage = config.enableCache
    ? new HybridStorageProvider(storage, { ttlMs: config.cacheTtl })
    : storage

  const consentManager = new ConsentManager(
    effectiveStorage,
    config.defaultConsent as 'allow' | 'deny',
  )
  const auditLogger = new AuditLogger(effectiveStorage, {
    sink: options.auditSink,
    cacheEntries: config.auditCacheEntries,
    required: config.auditRequired,
  })
  const ruleManager = new RuleManager(effectiveStorage)
  // Built once from the injected env. It used to be rebuilt inside the hash
  // primitive, from `process.env` rather than from the env the app was handed,
  // which on a runtime without `process` fell through to a hardcoded literal.
  const hasher = createHasher(config.hashSecret)

  app.use('*', requestLogger)
  app.route('/webhooks', createWebhookRouter(storage, config))

  // Static assets (dashboard + client bundle) resolved relative to the CWD.
  const normalizedCwd = (typeof process !== 'undefined' ? process.cwd() : '').replace(/\\/g, '/')
  const isServerSubdir =
    normalizedCwd.endsWith('/packages/server') || normalizedCwd.endsWith('/server')
  const adminDistPath = isServerSubdir ? '../admin/dist' : './packages/admin/dist'
  const clientBundlePath = isServerSubdir
    ? '../client/dist/sluice.iife.js'
    : './packages/client/dist/sluice.iife.js'

  app.use(
    '/dashboard/*',
    serveStatic({
      root: adminDistPath,
      rewriteRequestPath: (path) => path.replace(/^\/dashboard/, ''),
    }),
  )
  app.get('/dashboard', (c) => c.redirect('/dashboard/index.html'))
  app.use('/sluice-client.js', serveStatic({ path: clientBundlePath }))

  // CORS: browser calls to /ingest must send credentials (the identity cookie,
  // once consent has promoted one).
  // We reflect the request's origin only when it's in the allowlist so cookies
  // flow correctly, and 403 elsewhere at the app level.
  app.use(
    '*',
    cors({
      origin: (origin) => {
        if (!origin) return '*'
        if (config.allowedOrigins.length === 0) return origin
        return config.allowedOrigins.includes(origin) ? origin : ''
      },
      credentials: true,
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Consent-UserId', 'X-Original-Url'],
    }),
  )

  /**
   * Public liveness. It used to answer `ok` unconditionally, which made it a
   * statement about the process being up rather than about the firewall
   * working, so the storage result is now a real round trip. Deliberately thin:
   * record counts and retention windows are operational detail and live behind
   * the bearer on `/api/health`.
   */
  app.get('/health', async (c) => {
    const probe = await probeStorage(effectiveStorage)
    const evidenceAvailable = await auditLogger.evidenceAvailable()
    return c.json({
      // A firewall that is refusing every request because it cannot record what
      // it does is not healthy, whatever its storage says.
      status: probe.ok && evidenceAvailable ? 'ok' : 'degraded',
      storage: storage.constructor.name,
      storageOk: probe.ok,
      evidence: evidenceAvailable ? 'available' : 'unavailable',
    })
  })

  /**
   * Admin: what the operator surface is allowed to state as fact.
   *
   * Every field here is measured. The dashboard used to render "System Healthy"
   * and "Redis: Connected" as literal strings, which in a product whose value is
   * that its reporting is derived rather than asserted was the same class of
   * problem as an audit built from a rule's declarations.
   */
  app.get('/api/health', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)

    const probe = await probeStorage(effectiveStorage)
    const sink = await auditLogger.status()
    const evidenceAvailable = await auditLogger.evidenceAvailable()

    return c.json({
      status: probe.ok && evidenceAvailable ? 'ok' : 'degraded',
      storage: {
        kind: storage.constructor.name,
        ok: probe.ok,
        latencyMs: probe.latencyMs,
        error: probe.error,
      },
      audit: {
        ...sink,
        cacheEntries: config.auditCacheEntries,
        required: config.auditRequired,
        evidenceAvailable,
      },
      detectors: config.detectors,
      uptimeSeconds: metrics.getMetrics().uptimeSeconds,
    })
  })

  /**
   * Admin: consent CRUD by user id. Bearer-secured.
   */
  app.put('/consent/:userId', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)

    const userId = c.req.param('userId')
    const body = await c.req.json()
    const parsed = ConsentStateSchema.safeParse({ ...body, userId })
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

    await consentManager.setConsent(userId, parsed.data)
    return c.json({ status: 'saved' })
  })

  app.get('/consent/:userId', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    const userId = c.req.param('userId')
    return c.json(await consentManager.getConsent(userId))
  })

  /**
   * Admin: rule overrides.
   */
  /**
   * Each rule with what this deployment can actually do with it. `support` is
   * derived per request rather than stored: it depends on which adapters this
   * build registers, which is a property of the code and not of the rule.
   */
  app.get('/api/rules', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    return c.json((await ruleManager.getAllRules()).map(withSupport))
  })

  /**
   * An override that will not parse is discarded at read time in favour of the
   * registry, so accepting one here would report a save that changes nothing —
   * an operator surface stating something it has not established. It is
   * rejected at the door instead, with the schema's own reason.
   */
  app.put('/api/rules/:id', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    const id = c.req.param('id')
    const parsed = DestinationRuleSchema.safeParse({ ...(await c.req.json()), id })
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)
    await ruleManager.setOverride(id, parsed.data)
    return c.json({ status: 'saved' })
  })

  app.delete('/api/rules/:id', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    await ruleManager.deleteOverride(c.req.param('id'))
    return c.json({ status: 'deleted' })
  })

  app.get('/api/stats', (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    return c.json(metrics.getMetrics())
  })

  // Same counters as /api/stats, broken down per destination: which vendors a
  // site uses and how much of its traffic is being blocked. That is not public
  // information, so it takes the admin bearer — or a scrape token, when the
  // operator has explicitly configured one for a metrics collector.
  app.get('/metrics', (c) => {
    if (!requireAdmin(c, config) && !requireScrapeToken(c, config)) {
      return c.json({ error: 'Unauthorized' }, 403)
    }
    if (c.req.query('format') === 'prometheus') {
      return c.text(metrics.toPrometheus())
    }
    return c.json(metrics.getMetrics())
  })

  /**
   * Admin: the record, queryable.
   *
   * "Prove no email reached Meta last Tuesday" is the question this endpoint
   * exists to answer, so it takes a time range, a destination, a decision and a
   * detector rather than handing back the newest hundred and leaving the rest to
   * the reader. `format` returns the same page as a file, hashes included, so an
   * export can be re-verified against the chain instead of taken on trust.
   */
  app.get('/audit', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)

    const parsed = parseAuditQuery(c)
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400)

    const page = await auditLogger.query(parsed.query)
    const format = c.req.query('format')

    if (format === 'csv' || format === 'ndjson') {
      const body = format === 'csv' ? toCsv(page.records) : toNdjson(page.records)
      return c.text(body, 200, {
        'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="sluice-audit.${format}"`,
      })
    }

    return c.json(page)
  })

  /**
   * Admin: does the record still hold together.
   *
   * Every entry carries the digest of the one before it, so an edit, a deletion
   * or a reorder breaks the chain and shows up here with the sequence number it
   * broke at. Retention is not tampering: pruning writes an anchor, and a chain
   * that legitimately stops short of its genesis reports `truncated`.
   */
  app.get('/audit/verify', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    return c.json(await auditLogger.verify())
  })

  /**
   * Admin: which declared transformations have actually fired.
   *
   * A rule that never matches is a rule nobody is being protected by, and the
   * audit is the only thing that knows the difference. Derived from a bounded
   * scan of the retained record, and it says how far it scanned.
   */
  app.get('/api/rule-health', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)

    const parsed = parseAuditQuery(c)
    if (!parsed.ok) return c.json({ error: parsed.reason }, 400)

    return c.json(
      await deriveRuleHealth(auditLogger, await ruleManager.getAllRules(), {
        scanLimit: config.ruleHealthScan,
        from: parsed.query.from,
        to: parsed.query.to,
      }),
    )
  })

  /**
   * Admin: wipe the mutable state.
   *
   * The durable audit sink is deliberately not reset. A record that whoever
   * holds the admin token can delete proves nothing about what happened, so
   * this clears the display cache and leaves the evidence where it is.
   */
  app.delete('/api/debug/reset', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    metrics.reset()
    await auditLogger.clear()
    await storage.flushAll()
    return c.json({ status: 'reset_complete', auditSinkPreserved: true })
  })

  /**
   * Analytics ingestion. No shared secret — the browser cannot hold one
   * securely. Instead we require:
   *   - the request's Origin to be in SLUICE_ALLOWED_ORIGINS (or the list is empty in dev)
   *   - a resolvable user id (header, cookie, or query param)
   *   - a destination the registry (or override) knows about
   *   - a body no larger than SLUICE_MAX_BODY_BYTES
   *   - a forward URL the destination's own rule declares
   */
  app.all('/ingest/:destination', async (c) => {
    if (!requireAllowedOrigin(c, config)) return c.json({ error: 'origin_not_allowed' }, 403)

    const destination = c.req.param('destination')

    // The cookie comes first because only this server writes it, and only after
    // a consent record exists for that id. Everything else is the page talking:
    // a session identifier the browser minted for itself, which is what an
    // unconsented visitor has and all they should have.
    const userId =
      getCookie(c, IDENTITY_COOKIE) ||
      c.req.header('X-Consent-UserId') ||
      c.req.query('cuid') ||
      c.req.query('sluice_user_id')

    if (!userId) {
      metrics.recordRequest(destination, 'blocked')
      return c.body(null, 204)
    }

    if (!(await ruleManager.isSupported(destination))) {
      return c.json({ error: 'unsupported_destination' }, 400)
    }

    // Read the body once — we need it for both JSON parsing and raw-string
    // access (form-encoded vendors like GA4 beacons) — and never more of it
    // than a beacon could plausibly be. `/ingest` is public and unauthenticated,
    // so an unbounded read is memory any caller can spend.
    const rawBody = await readCappedBody(c, config.maxBodyBytes)
    if (rawBody === null) {
      metrics.recordRequest(destination, 'blocked')
      await auditLogger.log({
        userId,
        destination,
        decision: 'blocked',
        reason: 'payload_too_large',
      })
      return c.json({ error: 'payload_too_large' }, 413)
    }

    let jsonBody: any = null
    if (rawBody && (c.req.header('Content-Type') || '').includes('application/json')) {
      try {
        jsonBody = JSON.parse(rawBody)
      } catch {
        // Non-JSON body under JSON content-type is not fatal for adapters
        // that consume the raw string themselves.
      }
    }

    const consent = await consentManager.getConsent(userId)
    const rule = await ruleManager.getRule(destination)

    if (!consentManager.hasConsent(consent, rule.category)) {
      metrics.recordRequest(destination, 'blocked')
      await auditLogger.log({
        userId,
        destination,
        decision: 'blocked',
        reason: 'consent_missing',
        purposesRequired: rule.category,
        purposesGranted: Object.keys(consent.purposes).filter((k) => consent.purposes[k]),
      })
      return c.body(null, 204)
    }

    // Promotion, and the only place a persistent identifier is created. Until
    // consent exists for this id it lives for the browsing session and nowhere
    // else; a visitor who was never asked, or who said no, is never given one.
    // It is set from a first-party response rather than by `document.cookie`,
    // which Safari caps at seven days whatever expiry it names.
    if (consent._exists && !getCookie(c, IDENTITY_COOKIE)) {
      setCookie(c, IDENTITY_COOKIE, userId, identityCookieOptions(config))
    }

    // The evidence gate. Fail-closed already covers storage, parse and consent
    // failures; this applies it to the record itself. A configured sink that
    // cannot write means we would be forwarding personal data with no proof of
    // what we removed, which is the half of the claim that matters months later.
    if (!(await auditLogger.evidenceAvailable())) {
      metrics.recordRequest(destination, 'blocked')
      await auditLogger.log({
        userId,
        destination,
        decision: 'blocked',
        reason: 'evidence_unavailable',
        purposesRequired: rule.category,
      })
      return c.body(null, 204)
    }

    // A destination this build cannot serve is refused before anything is
    // built, not forwarded on the hope that the passthrough copes. The case
    // that matters is an encoded payload — Mixpanel's base64 `data`, Hotjar's
    // recording envelope — where neither scrub pass can see inside, so a
    // forward would carry personal data under an audit record truthfully
    // reporting that nothing was removed. Fail-closed applies to the evidence
    // as much as to the traffic.
    if (supportFor(rule) === 'unsupported') {
      metrics.recordRequest(destination, 'blocked')
      await auditLogger.log({
        userId,
        destination,
        decision: 'blocked',
        reason: 'destination_unsupported',
        purposesRequired: rule.category,
      })
      return c.body(null, 204)
    }

    const ctx: VendorContext = {
      method: c.req.method,
      originalUrl: c.req.header('X-Original-Url') || c.req.query('original') || '',
      query: new URL(c.req.url).searchParams,
      headers: lowercaseHeaders(c),
      jsonBody,
      rawBody,
      rule,
      serverConfig: config,
      hasher,
    }

    const built = await buildForward(ctx)

    if (!built.ok) {
      await auditLogger.log({
        userId,
        destination,
        decision: 'blocked',
        reason: built.reason,
        purposesRequired: rule.category,
      })
      metrics.recordRequest(destination, 'blocked')
      return c.body(null, 204)
    }

    const { forward } = built
    const purposesGranted = Object.keys(consent.purposes).filter((k) => consent.purposes[k])

    // The audit is written after the upstream call resolves, so `decision`
    // states what happened rather than what we intended.
    try {
      const response = await fetch(forward.url, {
        method: forward.method,
        headers: forward.headers,
        body: forward.method === 'GET' || forward.method === 'HEAD' ? undefined : forward.body,
        // A redirect is a second destination the rule never declared, chosen by
        // whoever answered the first one. `manual` hands the 3xx back as-is, so
        // it falls into the not-ok branch and is audited as an upstream status.
        redirect: 'manual',
      })
      if (!response.ok) {
        metrics.recordError()
        await auditLogger.log({
          userId,
          destination,
          decision: 'failed',
          reason: `upstream_status:${response.status}`,
          purposesRequired: rule.category,
          purposesGranted,
          transformations: forward.report,
        })
        return c.body(null, 502)
      }
      metrics.recordRequest(destination, 'forwarded')
      await auditLogger.log({
        userId,
        destination,
        decision: 'forwarded',
        reason: 'consent_granted',
        purposesRequired: rule.category,
        purposesGranted,
        transformations: forward.report,
      })
      return c.body(null, 204)
    } catch (error) {
      console.error(`[Sluice] Upstream forward failed for ${destination}:`, error)
      metrics.recordError()
      await auditLogger.log({
        userId,
        destination,
        decision: 'failed',
        reason: 'upstream_unreachable',
        purposesRequired: rule.category,
        purposesGranted,
        transformations: forward.report,
      })
      return c.body(null, 502)
    }
  })

  return app
}

// ---------- helpers ----------

/**
 * Request logging, path only.
 *
 * Hono's own `logger()` derives its path by slicing the raw URL, which keeps
 * the query string. A beacon puts personal data there — `?original=` carries
 * the vendor URL the browser targeted, email and all — so every intercepted
 * request wrote the values to stdout, including ones that were blocked. The
 * audit deliberately never records a removed value; neither does this.
 */
async function requestLogger(c: Context, next: () => Promise<void>): Promise<void> {
  const start = Date.now()
  await next()
  const { pathname } = new URL(c.req.url)
  console.log(`${c.req.method} ${pathname} ${c.res.status} ${Date.now() - start}ms`)
}

/**
 * Read the request body, refusing anything past `limit` instead of buffering it.
 *
 * `Content-Length` is a claim, not a measurement, so the stream is counted as it
 * arrives and abandoned the moment it goes over. A returned `null` means the
 * body was too large and was never fully read.
 */
async function readCappedBody(c: Context, limit: number): Promise<string | null> {
  const declared = Number(c.req.header('Content-Length'))
  if (Number.isFinite(declared) && declared > limit) return null

  const body = c.req.raw.body
  if (!body) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > limit) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(joined)
}

/**
 * Turn an intercepted request into the concrete upstream call, scrubbed and
 * addressed somewhere the destination rule allows.
 *
 * Every forward goes through here, so the "scrub before egress, always" and
 * "only where the rule says" invariants live in exactly one place. Every
 * outcome that is not `ok` means the request is not forwarded.
 */
type BuildOutcome = { ok: true; forward: VendorForward } | { ok: false; reason: string }

async function buildForward(ctx: VendorContext): Promise<BuildOutcome> {
  const built = await routeForward(ctx)
  if (!built.ok) return built

  const forward = withScrubbedUrl(built.forward, ctx)

  // Last gate before egress, applied to the URL that will actually be fetched
  // rather than to the string the caller supplied. An adapter's own URL is
  // checked too: putting it here leaves no branch that can forget.
  const verdict = checkEgress(forward.url, ctx.rule)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }

  return { ok: true, forward }
}

async function routeForward(ctx: VendorContext): Promise<BuildOutcome> {
  const adapter = getAdapter(ctx.rule.id)

  if (adapter) {
    const result = await adapter.buildRequest(ctx)
    if (!result) return { ok: false, reason: 'adapter_returned_null' }
    if ('skip' in result) return { ok: false, reason: `adapter_skip:${result.reason}` }
    return { ok: true, forward: result }
  }

  // A pixel — an <img> beacon — carries its whole payload in the query string
  // and has no body at all. `withScrubbedUrl` covers the query, so scrubbing
  // the only half that exists is a complete scrub rather than a partial one.
  // Without an original URL there is nothing to forward, so it falls through
  // and is refused below.
  if (!ctx.rawBody && ctx.originalUrl) {
    return {
      ok: true,
      forward: {
        url: ctx.originalUrl,
        method: 'GET',
        headers: { 'User-Agent': ctx.headers['user-agent'] || 'Sluice Proxy' },
        body: '',
        report: [],
      },
    }
  }

  // No adapter → generic JSON passthrough. Only useful for testing; a real
  // vendor needs a real adapter.
  if (!ctx.rule.upstreamUrl) return { ok: false, reason: 'no_adapter_and_no_upstream_url' }

  // A body we cannot parse is a body we cannot scrub, and an unscrubbed
  // payload never goes upstream.
  if (!ctx.jsonBody || typeof ctx.jsonBody !== 'object') {
    return { ok: false, reason: 'unscrubbable_payload' }
  }

  const scrub = scrubPayload(ctx.jsonBody, ctx.rule, {
    detectors: ctx.serverConfig.detectors,
    hasher: ctx.hasher,
  })
  return {
    ok: true,
    forward: {
      url: ctx.originalUrl || ctx.rule.upstreamUrl,
      method: ctx.method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': ctx.headers['user-agent'] || 'Sluice Proxy',
      },
      body: JSON.stringify(scrub.payload),
      report: scrub.report,
    },
  }
}

/**
 * Scrub the URL a forward is about to be sent to, and fold what that removed
 * into the same report the body scrub produced.
 *
 * The passthrough forwards to the URL the browser originally targeted, so its
 * query string reaches the vendor verbatim unless it is scrubbed here. Adapters
 * build their own URLs and go through this too, because `buildForward` applies
 * it to whatever the routing step hands back.
 */
function withScrubbedUrl(forward: VendorForward, ctx: VendorContext): VendorForward {
  const scrub = scrubUrl(forward.url, ctx.rule, {
    detectors: ctx.serverConfig.detectors,
    hasher: ctx.hasher,
  })
  if (scrub.report.length === 0) return forward
  return { ...forward, url: scrub.url, report: [...forward.report, ...scrub.report] }
}

/**
 * A real storage round trip, rather than the fact that the process is running.
 *
 * Writes a probe key, reads it back, and removes it. `/health` used to answer
 * `ok` unconditionally and the dashboard printed "Redis: Connected" as a
 * literal; both were statements nobody had measured.
 */
async function probeStorage(
  storage: StorageProvider,
): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  const key = 'sluice_health_probe'
  const token = `${Date.now()}`
  const start = Date.now()

  try {
    await storage.set(key, token, 30)
    const readBack = await storage.get(key)
    await storage.del(key)
    if (readBack !== token) {
      return { ok: false, latencyMs: Date.now() - start, error: 'probe value did not read back' }
    }
    return { ok: true, latencyMs: Date.now() - start, error: null }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

type ParsedQuery = { ok: true; query: AuditQuery } | { ok: false; reason: string }

/**
 * Turn `/audit`'s query string into a filter.
 *
 * Rejects rather than silently ignores: an operator producing evidence needs to
 * know that a mistyped `decision=forwaded` narrowed nothing, not to be handed a
 * full page and left to assume it was filtered.
 */
function parseAuditQuery(c: Context): ParsedQuery {
  const query: AuditQuery = {}

  for (const key of ['from', 'to'] as const) {
    const value = c.req.query(key)
    if (value === undefined) continue
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return { ok: false, reason: `invalid_${key}` }
    query[key] = parsed.toISOString()
  }

  const decision = c.req.query('decision')
  if (decision !== undefined) {
    if (decision !== 'forwarded' && decision !== 'blocked' && decision !== 'failed') {
      return { ok: false, reason: 'invalid_decision' }
    }
    query.decision = decision
  }

  const detector = c.req.query('detector')
  if (detector !== undefined) {
    if (!PiiDetectorSchema.safeParse(detector).success) {
      return { ok: false, reason: 'invalid_detector' }
    }
    query.detector = detector
  }

  const destination = c.req.query('destination')
  if (destination) query.destination = destination

  const userId = c.req.query('userId')
  if (userId) query.userId = userId

  const limit = c.req.query('limit')
  if (limit !== undefined) {
    const parsed = Number(limit)
    if (!Number.isInteger(parsed) || parsed < 1) return { ok: false, reason: 'invalid_limit' }
    query.limit = parsed
  }

  const cursor = c.req.query('cursor')
  if (cursor !== undefined) {
    const parsed = Number(cursor)
    if (!Number.isInteger(parsed) || parsed < 0) return { ok: false, reason: 'invalid_cursor' }
    query.cursor = parsed
  }

  return { ok: true, query }
}

/**
 * A year, HttpOnly, and first-party.
 *
 * `HttpOnly` because nothing in the page needs to read this: the browser sends
 * it automatically, and a script that cannot read the identifier cannot ship it
 * to a vendor of its own accord. `Secure` is dropped only in development, where
 * the proxy is reached over plain http and the browser would discard the cookie.
 */
function identityCookieOptions(config: ServerConfig) {
  const isDev = config.env === 'development' || config.env === 'test'
  return {
    path: '/',
    httpOnly: true,
    secure: !isDev,
    sameSite: 'Lax' as const,
    maxAge: 365 * 24 * 60 * 60,
  }
}

function requireAdmin(c: Context, config: ServerConfig): boolean {
  const auth = c.req.header('Authorization')
  return auth === `Bearer ${config.adminSecret}`
}

/** Read-only scrape access for a metrics collector. Off unless configured. */
function requireScrapeToken(c: Context, config: ServerConfig): boolean {
  if (!config.metricsToken) return false
  return c.req.header('Authorization') === `Bearer ${config.metricsToken}`
}

/**
 * An empty allowlist is permissive; that is a dev-only default.
 *
 * A configured allowlist used to treat a missing `Origin` as permission, on the
 * grounds that non-browser callers are fine. Every tool that is not a browser
 * omits the header, so the allowlist stopped browsers and nothing else. If the
 * operator has said which origins may use the firewall, a request that does not
 * say where it is from is not one of them.
 */
function requireAllowedOrigin(c: Context, config: ServerConfig): boolean {
  if (config.allowedOrigins.length === 0) return true
  const origin = c.req.header('Origin')
  if (!origin) return false
  return config.allowedOrigins.includes(origin)
}

function lowercaseHeaders(c: Context): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = c.req.raw?.headers
  if (!raw) return out
  raw.forEach((value, key) => {
    out[key.toLowerCase()] = value
  })
  return out
}

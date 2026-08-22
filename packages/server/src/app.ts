import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { getCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { ConsentStateSchema } from '@sluice/shared'
import { ConsentManager } from './engine/consent'
import { scrubPayload } from './engine/transformer'
import { scrubUrl } from './engine/url'
import { metrics } from './engine/metrics'
import { AuditLogger } from './engine/audit'
import { checkEgress } from './engine/egress'
import { RuleManager } from './engine/rules'
import { createWebhookRouter } from './webhooks/cmp'
import { StorageProvider, HybridStorageProvider } from './engine/storage'
import { getServerConfig, ServerConfig } from './config'
import { getAdapter, VendorContext, VendorForward } from './destinations/adapters'

export function createApp(storage: StorageProvider, env: any = {}) {
  const app = new Hono()
  const config = getServerConfig(env)

  const effectiveStorage = config.enableCache
    ? new HybridStorageProvider(storage, { ttlMs: config.cacheTtl })
    : storage

  const consentManager = new ConsentManager(
    effectiveStorage,
    config.defaultConsent as 'allow' | 'deny',
  )
  const auditLogger = new AuditLogger(effectiveStorage)
  const ruleManager = new RuleManager(effectiveStorage)

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

  // CORS: browser calls to /ingest must send credentials (the cuid cookie).
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

  app.get('/health', (c) => c.json({ status: 'ok', storage: storage.constructor.name }))

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
  app.get('/api/rules', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    return c.json(await ruleManager.getAllRules())
  })

  app.put('/api/rules/:id', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    await ruleManager.setOverride(c.req.param('id'), await c.req.json())
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

  app.get('/audit', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    return c.json(await auditLogger.getLogs(100))
  })

  app.delete('/api/debug/reset', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    metrics.reset()
    await auditLogger.clear()
    await storage.flushAll()
    return c.json({ status: 'reset_complete' })
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

    const userId =
      c.req.header('X-Consent-UserId') ||
      getCookie(c, 'cuid') ||
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

    const ctx: VendorContext = {
      method: c.req.method,
      originalUrl: c.req.header('X-Original-Url') || c.req.query('original') || '',
      query: new URL(c.req.url).searchParams,
      headers: lowercaseHeaders(c),
      jsonBody,
      rawBody,
      rule,
      serverConfig: config,
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

  const scrub = scrubPayload(ctx.jsonBody, ctx.rule, { detectors: ctx.serverConfig.detectors })
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
  const scrub = scrubUrl(forward.url, ctx.rule, { detectors: ctx.serverConfig.detectors })
  if (scrub.report.length === 0) return forward
  return { ...forward, url: scrub.url, report: [...forward.report, ...scrub.report] }
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

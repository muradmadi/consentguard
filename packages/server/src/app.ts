import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { ConsentStateSchema } from '@sluice/shared'
import { ConsentManager } from './engine/consent'
import { scrubPayload } from './engine/transformer'
import { scrubUrl } from './engine/url'
import { metrics } from './engine/metrics'
import { AuditLogger } from './engine/audit'
import { BufferManager } from './engine/buffer'
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
  const bufferManager = new BufferManager(effectiveStorage)
  const ruleManager = new RuleManager(effectiveStorage)

  app.use('*', logger())
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

  // CORS: browser calls to /ingest and /consent/self must send credentials
  // (the cuid cookie). We reflect the request's origin only when it's in the
  // allowlist so cookies flow correctly, and 403 elsewhere at the app level.
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
    const replayed = await replayBuffered(userId, parsed.data, {
      consentManager,
      auditLogger,
      ruleManager,
      config,
      bufferManager,
    })
    return c.json({ status: 'saved', replayed })
  })

  app.get('/consent/:userId', async (c) => {
    if (!requireAdmin(c, config)) return c.json({ error: 'Unauthorized' }, 403)
    const userId = c.req.param('userId')
    return c.json(await consentManager.getConsent(userId))
  })

  /**
   * Public: browser-callable consent update. No admin secret. Trusts the
   * cuid cookie (or X-Consent-UserId header) and the request's Origin,
   * which is validated by the allowlist below.
   */
  app.post('/consent/self', async (c) => {
    if (!requireAllowedOrigin(c, config)) return c.json({ error: 'origin_not_allowed' }, 403)

    const cookieUserId = getCookie(c, 'cuid')
    const headerUserId = c.req.header('X-Consent-UserId')
    let userId = cookieUserId || headerUserId

    // No cookie yet? Mint one so the same browser is identifiable next time.
    if (!userId) {
      userId = generateUserId()
      setCookie(c, 'cuid', userId, {
        path: '/',
        sameSite: 'Lax',
        httpOnly: false,
        maxAge: 60 * 60 * 24 * 365,
      })
    }

    let body: any
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'invalid_json' }, 400)
    }

    const parsed = ConsentStateSchema.safeParse({
      userId,
      purposes: { necessary: true, ...(body.purposes || {}) },
      timestamp: typeof body.timestamp === 'number' ? body.timestamp : Date.now(),
      metadata: body.metadata,
    })
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400)

    await consentManager.setConsent(userId, parsed.data)
    const replayed = await replayBuffered(userId, parsed.data, {
      consentManager,
      auditLogger,
      ruleManager,
      config,
      bufferManager,
    })
    return c.json({ status: 'saved', userId, replayed })
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

  app.get('/metrics', (c) => {
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
    // access (form-encoded vendors like GA4 beacons).
    const rawBody = c.req.header('Content-Length') === '0' ? '' : await c.req.text()
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
      if (!consent._exists && config.bufferPending) {
        await bufferManager.bufferRequest(userId, {
          destination,
          payload: jsonBody ?? rawBody,
          method: c.req.method,
          headers: {
            'Content-Type': c.req.header('Content-Type') || 'application/json',
            'User-Agent': c.req.header('User-Agent') || 'Sluice Proxy',
          },
          originalUrl: c.req.header('X-Original-Url') || rule.upstreamUrl,
        })
        await auditLogger.log({
          userId,
          destination,
          decision: 'buffered',
          reason: 'new_user_pending_consent',
          purposesRequired: rule.category,
        })
        return c.body(null, 202)
      }

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
 * Turn an intercepted request into the concrete upstream call, scrubbed.
 *
 * Both the live ingest path and the buffer replay go through here, so the
 * "scrub before egress, always" invariant lives in exactly one place. Every
 * outcome that is not `ok` means the request is not forwarded.
 */
type BuildOutcome = { ok: true; forward: VendorForward } | { ok: false; reason: string }

async function buildForward(ctx: VendorContext): Promise<BuildOutcome> {
  const adapter = getAdapter(ctx.rule.id)

  if (adapter) {
    const result = await adapter.buildRequest(ctx)
    if (!result) return { ok: false, reason: 'adapter_returned_null' }
    if ('skip' in result) return { ok: false, reason: `adapter_skip:${result.reason}` }
    return { ok: true, forward: withScrubbedUrl(result, ctx) }
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
    forward: withScrubbedUrl(
      {
        url: ctx.originalUrl || ctx.rule.upstreamUrl,
        method: ctx.method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': ctx.headers['user-agent'] || 'Sluice Proxy',
        },
        body: JSON.stringify(scrub.payload),
        report: scrub.report,
      },
      ctx,
    ),
  }
}

/**
 * Scrub the URL a forward is about to be sent to, and fold what that removed
 * into the same report the body scrub produced.
 *
 * The passthrough forwards to the URL the browser originally targeted, so its
 * query string reaches the vendor verbatim unless it is scrubbed here. Adapters
 * build their own URLs and go through this too: putting it on every forward
 * leaves no branch where it can be forgotten.
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

function requireAllowedOrigin(c: Context, config: ServerConfig): boolean {
  if (config.allowedOrigins.length === 0) return true
  const origin = c.req.header('Origin')
  if (!origin) return true // non-browser callers (curl, server-to-server) are fine
  return config.allowedOrigins.includes(origin)
}

function lowercaseRecord(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
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

function generateUserId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return 'u_' + Math.random().toString(36).slice(2, 15)
}

async function replayBuffered(
  userId: string,
  consent: any,
  deps: {
    consentManager: ConsentManager
    auditLogger: AuditLogger
    ruleManager: RuleManager
    bufferManager: BufferManager
    config: ServerConfig
  },
): Promise<number> {
  const { consentManager, auditLogger, ruleManager, bufferManager, config } = deps
  const buffered = await bufferManager.getAndClearBuffer(userId)
  if (buffered.length === 0) return 0

  // Fire-and-forget so the caller isn't blocked on upstream latency.
  ;(async () => {
    for (const req of buffered) {
      const rule = await ruleManager.getRule(req.destination)
      if (!consentManager.hasConsent(consent, rule.category)) {
        await auditLogger.log({
          userId,
          destination: req.destination,
          decision: 'blocked',
          reason: 'replayed_but_still_no_consent',
          purposesRequired: rule.category,
        })
        continue
      }

      // Replay goes through the same builder as the live path. A buffered
      // payload we stored as a raw string has no JSON shape to scrub, so it is
      // dropped rather than forwarded.
      const isObject = !!req.payload && typeof req.payload === 'object'
      const built = await buildForward({
        method: req.method,
        originalUrl: req.originalUrl || rule.upstreamUrl || '',
        query: new URLSearchParams(),
        headers: lowercaseRecord(req.headers),
        jsonBody: isObject ? req.payload : null,
        rawBody: typeof req.payload === 'string' ? req.payload : '',
        rule,
        serverConfig: config,
      })

      if (!built.ok) {
        await auditLogger.log({
          userId,
          destination: req.destination,
          decision: 'blocked',
          reason: `replayed_${built.reason}`,
          purposesRequired: rule.category,
        })
        continue
      }

      const { forward } = built
      try {
        const response = await fetch(forward.url, {
          method: forward.method,
          headers: forward.headers,
          body: forward.method === 'GET' || forward.method === 'HEAD' ? undefined : forward.body,
        })
        await auditLogger.log({
          userId,
          destination: req.destination,
          decision: response.ok ? 'forwarded' : 'failed',
          reason: response.ok
            ? 'replayed_from_buffer'
            : `replayed_upstream_status:${response.status}`,
          purposesRequired: rule.category,
          transformations: forward.report,
        })
      } catch (e) {
        console.error(`[Sluice] Replay failed for ${req.destination}:`, e)
        await auditLogger.log({
          userId,
          destination: req.destination,
          decision: 'failed',
          reason: 'replayed_upstream_unreachable',
          purposesRequired: rule.category,
          transformations: forward.report,
        })
      }
    }
  })()

  return buffered.length
}

import { Hono, Context } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from '@hono/node-server/serve-static'
import { ConsentStateSchema } from '@consentguard/shared'
import { ConsentManager } from './engine/consent'
import { scrubPayload } from './engine/transformer'
import { metrics } from './engine/metrics'
import { AuditLogger } from './engine/audit'
import { BufferManager } from './engine/buffer'
import { RuleManager } from './engine/rules'
import { createWebhookRouter } from './webhooks/cmp'
import { StorageProvider, HybridStorageProvider } from './engine/storage'
import { getServerConfig, ServerConfig } from './config'
import { getAdapter, VendorContext } from './destinations/adapters'

export function createApp(storage: StorageProvider, env: any = {}) {
  const app = new Hono()
  const config = getServerConfig(env)

  const effectiveStorage = config.enableCache
    ? new HybridStorageProvider(storage, { ttlMs: config.cacheTtl })
    : storage

  const consentManager = new ConsentManager(effectiveStorage, config.defaultConsent as 'allow' | 'deny')
  const auditLogger = new AuditLogger(effectiveStorage)
  const bufferManager = new BufferManager(effectiveStorage)
  const ruleManager = new RuleManager(effectiveStorage)

  app.use('*', logger())
  app.route('/webhooks', createWebhookRouter(storage, config))

  // Static assets (dashboard + client bundle) resolved relative to the CWD.
  const normalizedCwd = (typeof process !== 'undefined' ? process.cwd() : '').replace(/\\/g, '/')
  const isServerSubdir = normalizedCwd.endsWith('/packages/server') || normalizedCwd.endsWith('/server')
  const adminDistPath = isServerSubdir ? '../admin/dist' : './packages/admin/dist'
  const clientBundlePath = isServerSubdir
    ? '../client/dist/consentguard.iife.js'
    : './packages/client/dist/consentguard.iife.js'

  app.use('/dashboard/*', serveStatic({
    root: adminDistPath,
    rewriteRequestPath: (path) => path.replace(/^\/dashboard/, ''),
  }))
  app.get('/dashboard', (c) => c.redirect('/dashboard/index.html'))
  app.use('/consentguard-client.js', serveStatic({ path: clientBundlePath }))

  // CORS: browser calls to /ingest and /consent/self must send credentials
  // (the cuid cookie). We reflect the request's origin only when it's in the
  // allowlist so cookies flow correctly, and 403 elsewhere at the app level.
  app.use('*', cors({
    origin: (origin) => {
      if (!origin) return '*'
      if (config.allowedOrigins.length === 0) return origin
      return config.allowedOrigins.includes(origin) ? origin : ''
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Consent-UserId', 'X-Original-Url'],
  }))

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
    const replayed = await replayBuffered(userId, parsed.data, { consentManager, auditLogger, ruleManager, config, bufferManager })
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
    const replayed = await replayBuffered(userId, parsed.data, { consentManager, auditLogger, ruleManager, config, bufferManager })
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
   *   - the request's Origin to be in CG_ALLOWED_ORIGINS (or the list is empty in dev)
   *   - a resolvable user id (header, cookie, or query param)
   *   - a destination the registry (or override) knows about
   */
  app.all('/ingest/:destination', async (c) => {
    if (!requireAllowedOrigin(c, config)) return c.json({ error: 'origin_not_allowed' }, 403)

    const destination = c.req.param('destination')

    const userId = c.req.header('X-Consent-UserId')
      || getCookie(c, 'cuid')
      || c.req.query('cuid')
      || c.req.query('cg_user_id')

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
            'User-Agent': c.req.header('User-Agent') || 'ConsentGuard Proxy',
          },
          originalUrl: c.req.header('X-Original-Url') || rule.upstreamUrl,
        })
        await auditLogger.log({
          userId, destination,
          decision: 'buffered',
          reason: 'new_user_pending_consent',
          purposesRequired: rule.category,
        })
        return c.body(null, 202)
      }

      metrics.recordRequest(destination, 'blocked')
      await auditLogger.log({
        userId, destination,
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

    const adapter = getAdapter(destination)
    let forward: { url: string; method: string; headers: Record<string, string>; body: string } | null

    if (adapter) {
      const result = await adapter.buildRequest(ctx)
      if (result && 'skip' in result) {
        // Adapter deliberately declined — treat as a drop.
        await auditLogger.log({
          userId, destination,
          decision: 'blocked',
          reason: `adapter_skip:${result.reason}`,
          purposesRequired: rule.category,
        })
        metrics.recordRequest(destination, 'blocked')
        return c.body(null, 204)
      }
      forward = result
    } else {
      // No adapter registered → generic passthrough. Only works if the rule
      // has an upstreamUrl and the vendor accepts JSON. This is scaffolding;
      // real destinations need real adapters.
      if (!rule.upstreamUrl) {
        await auditLogger.log({
          userId, destination,
          decision: 'blocked',
          reason: 'no_adapter_and_no_upstream_url',
          purposesRequired: rule.category,
        })
        return c.body(null, 204)
      }
      const payload = jsonBody ?? {}
      const scrubbed = scrubPayload(payload, rule)
      forward = {
        url: c.req.header('X-Original-Url') || rule.upstreamUrl,
        method: c.req.method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.req.header('User-Agent') || 'ConsentGuard Proxy',
        },
        body: JSON.stringify(scrubbed),
      }
    }

    if (!forward) {
      // Adapter returned null: drop cleanly.
      await auditLogger.log({
        userId, destination,
        decision: 'blocked',
        reason: 'adapter_returned_null',
        purposesRequired: rule.category,
      })
      metrics.recordRequest(destination, 'blocked')
      return c.body(null, 204)
    }

    const transformationsApplied = rule.transformations?.map((t) => `${t.action}:${t.path}`) || []
    await auditLogger.log({
      userId, destination,
      decision: transformationsApplied.length > 0 ? 'scrubbed' : 'forwarded',
      reason: 'consent_granted',
      purposesRequired: rule.category,
      purposesGranted: Object.keys(consent.purposes).filter((k) => consent.purposes[k]),
      transformationsApplied,
    })
    metrics.recordRequest(destination, 'forwarded')

    try {
      const response = await fetch(forward.url, {
        method: forward.method,
        headers: forward.headers,
        body: forward.method === 'GET' || forward.method === 'HEAD' ? undefined : forward.body,
      })
      if (!response.ok) {
        metrics.recordError()
        return c.body(null, 502)
      }
      return c.body(null, 204)
    } catch (error) {
      console.error(`[ConsentGuard] Upstream forward failed for ${destination}:`, error)
      metrics.recordError()
      return c.body(null, 502)
    }
  })

  return app
}

// ---------- helpers ----------

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
  const { consentManager, auditLogger, ruleManager, bufferManager } = deps
  const buffered = await bufferManager.getAndClearBuffer(userId)
  if (buffered.length === 0) return 0

  // Fire-and-forget so the caller isn't blocked on upstream latency.
  ;(async () => {
    for (const req of buffered) {
      const rule = await ruleManager.getRule(req.destination)
      if (!consentManager.hasConsent(consent, rule.category)) {
        await auditLogger.log({
          userId, destination: req.destination,
          decision: 'blocked',
          reason: 'replayed_but_still_no_consent',
          purposesRequired: rule.category,
        })
        continue
      }
      const targetUrl = req.originalUrl || rule.upstreamUrl
      if (!targetUrl) continue
      try {
        const payload = typeof req.payload === 'string' ? req.payload : JSON.stringify(scrubPayload(req.payload, rule))
        await fetch(targetUrl, { method: req.method, headers: req.headers, body: payload })
        await auditLogger.log({
          userId, destination: req.destination,
          decision: 'forwarded',
          reason: 'replayed_from_buffer',
          purposesRequired: rule.category,
        })
      } catch (e) {
        console.error(`[ConsentGuard] Replay failed for ${req.destination}:`, e)
      }
    }
  })()

  return buffered.length
}

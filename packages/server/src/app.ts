import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { ConsentStateSchema } from '@consentguard/shared'
import { ConsentManager } from './engine/consent'
import { getDestinationRule, getDefaultRule } from './destinations/registry'
import { scrubPayload } from './engine/transformer'
import { metrics } from './engine/metrics'
import { AuditLogger } from './engine/audit'
import { BufferManager } from './engine/buffer'
import { RuleManager } from './engine/rules'
import { createWebhookRouter } from './webhooks/cmp'
import { StorageProvider } from './engine/storage'
import { getServerConfig } from './config'

export function createApp(storage: StorageProvider, env: any = {}) {
  const app = new Hono()
  const config = getServerConfig(env)
  
  const consentManager = new ConsentManager(storage)
  const auditLogger = new AuditLogger(storage)
  const bufferManager = new BufferManager(storage)
  const ruleManager = new RuleManager(storage)

  app.use('*', logger())
  app.route('/webhooks', createWebhookRouter(storage))
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Consent-UserId', 'X-Original-Url'],
    exposeHeaders: ['Content-Length', 'X-Consent-UserId'],
  }))

  app.get('/health', async (c) => {
    return c.json({ status: 'ok', storage: storage.constructor.name })
  })

  /**
   * Consent Management API
   */
  app.put('/consent/:userId', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)

    const userId = c.req.param('userId')
    const body = await c.req.json()
    
    const result = ConsentStateSchema.safeParse({ ...body, userId })
    if (!result.success) return c.json({ error: result.error }, 400)

    await consentManager.setConsent(userId, result.data)

    // Trigger Replay if buffer exists
    const buffered = await bufferManager.getAndClearBuffer(userId)
    if (buffered.length > 0) {
      console.log(`[ConsentGuard] Replaying ${buffered.length} buffered requests for ${userId}`)
      // We fire and forget the replay to avoid blocking the consent response
      replayBufferedRequests(userId, buffered, result.data, { consentManager, auditLogger, ruleManager })
    }

    return c.json({ status: 'saved', replayed: buffered.length })
  })

  app.get('/consent/:userId', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)

    const userId = c.req.param('userId')
    const consent = await consentManager.getConsent(userId)
    return c.json(consent)
  })

  /**
   * Rule Management API
   */
  app.get('/api/rules', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)
    const rules = await ruleManager.getAllRules()
    return c.json(rules)
  })

  app.put('/api/rules/:id', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)
    const id = c.req.param('id')
    const body = await c.req.json()
    await ruleManager.setOverride(id, body)
    return c.json({ status: 'saved' })
  })

  app.delete('/api/rules/:id', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)
    const id = c.req.param('id')
    await ruleManager.deleteOverride(id)
    return c.json({ status: 'deleted' })
  })

  app.get('/api/stats', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)
    
    // In a real app, we'd pull these from Redis or a metrics store.
    // For now, we'll return the in-memory metrics.
    return c.json(metrics.getMetrics())
  })

  app.get('/metrics', async (c) => {
    const format = c.req.query('format')
    if (format === 'prometheus') {
      return c.text(metrics.toPrometheus())
    }
    return c.json(metrics.getMetrics())
  })

  app.get('/audit', async (c) => {
    const auth = c.req.header('Authorization')
    if (auth !== `Bearer ${config.adminSecret}`) return c.json({ error: 'Unauthorized' }, 403)
    
    const logs = await auditLogger.getLogs(100)
    return c.json(logs)
  })

  /**
   * Analytics Ingestion API
   */
  app.post('/ingest/:destination', async (c) => {
    const destination = c.req.param('destination')
    const userId = c.req.header('X-Consent-UserId') || 'anonymous'
    const payload = await c.req.json()

    // 0. Authenticate Proxy Request
    const auth = c.req.header('Authorization') || `Bearer ${c.req.query('key')}`
    if (auth !== `Bearer ${config.proxySecret}`) {
      console.warn(`[ConsentGuard] Unauthorized ingestion attempt for ${destination}`)
      return c.json({ error: 'Unauthorized' }, 403)
    }

    // 1. Resolve Consent
    const consent = await consentManager.getConsent(userId)

    // 2. Resolve Rule (Dynamic)
    const rule = await ruleManager.getRule(destination)

    // 3. Check Category Consent
    if (!consentManager.hasConsent(consent, rule.category)) {
      // Check if we should buffer (new user and pending consent)
      if (!consent._exists && config.bufferPending !== false) {
        console.log(`[ConsentGuard] Buffering ${destination} for new user ${userId}`)
        await bufferManager.bufferRequest(userId, {
          destination,
          payload,
          method: c.req.method,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': c.req.header('User-Agent') || 'ConsentGuard Proxy',
          },
          originalUrl: c.req.header('X-Original-Url') || rule.upstreamUrl
        })

        await auditLogger.log({
          userId,
          destination,
          decision: 'buffered',
          reason: 'new_user_pending_consent',
          purposesRequired: rule.category
        })

        return c.body(null, 202) // Accepted (but pending)
      }

      console.log(`[ConsentGuard] Blocked ${destination} for user ${userId} (Category: ${rule.category})`)
      metrics.recordRequest(destination, 'blocked')
      
      await auditLogger.log({
        userId,
        destination,
        decision: 'blocked',
        reason: 'consent_missing',
        purposesRequired: rule.category,
        purposesGranted: Object.keys(consent.purposes).filter(k => consent.purposes[k])
      })

      return c.body(null, 204)
    }

    // 4. Scrub Payload
    const scrubbed = scrubPayload(payload, rule)
    const transformationsApplied = rule.transformations?.map(t => `${t.action}:${t.path}`) || []

    // 5. Forward
    const targetUrl = c.req.header('X-Original-Url') || rule.upstreamUrl
    if (!targetUrl) {
      console.error(`[ConsentGuard] No target URL found for ${destination}`)
      return c.json({ error: 'Missing target URL' }, 400)
    }

    console.log(`[ConsentGuard] Forwarding scrubbed ${destination} for user ${userId} to ${targetUrl}`)
    metrics.recordRequest(destination, 'forwarded')

    await auditLogger.log({
      userId,
      destination,
      decision: transformationsApplied.length > 0 ? 'scrubbed' : 'forwarded',
      reason: 'consent_granted',
      purposesRequired: rule.category,
      purposesGranted: Object.keys(consent.purposes).filter(k => consent.purposes[k]),
      transformationsApplied
    })

    try {
      const response = await fetch(targetUrl, {
        method: c.req.method,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': c.req.header('User-Agent') || 'ConsentGuard Proxy',
        },
        body: JSON.stringify(scrubbed),
      })

      return c.body(null, response.status as any)
    } catch (error) {
      console.error(`[ConsentGuard] Failed to forward to ${destination}:`, error)
      metrics.recordError()
      return c.json({ error: 'Upstream connection failed' }, 502)
    }
  })

  return app
}

/**
 * Replay Helper
 */
async function replayBufferedRequests(userId: string, buffered: any[], consent: any, deps: { consentManager: ConsentManager, auditLogger: AuditLogger, ruleManager: RuleManager }) {
  const { consentManager, auditLogger, ruleManager } = deps
  for (const req of buffered) {
    const rule = await ruleManager.getRule(req.destination)
    
    if (consentManager.hasConsent(consent, rule.category)) {
      const scrubbed = scrubPayload(req.payload, rule)
      const targetUrl = req.originalUrl || rule.upstreamUrl
      
      if (!targetUrl) continue

      try {
        await fetch(targetUrl, {
          method: req.method,
          headers: req.headers,
          body: JSON.stringify(scrubbed),
        })
        
        await auditLogger.log({
          userId,
          destination: req.destination,
          decision: 'forwarded',
          reason: 'replayed_from_buffer',
          purposesRequired: rule.category
        })
      } catch (e) {
        console.error(`[ConsentGuard] Replay failed for ${req.destination}:`, e)
      }
    } else {
      await auditLogger.log({
        userId,
        destination: req.destination,
        decision: 'blocked',
        reason: 'replayed_but_still_no_consent',
        purposesRequired: rule.category
      })
    }
  }
}

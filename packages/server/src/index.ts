import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { ConsentStateSchema, defaultConfig } from '@consentguard/shared'
import { ConsentManager } from './engine/consent'
import { getDestinationRule, getDefaultRule } from './destinations/registry'
import { scrubPayload } from './engine/transformer'

import { cors } from 'hono/cors'

const app = new Hono()

app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Consent-UserId', 'X-Original-Url'],
  exposeHeaders: ['Content-Length', 'X-Consent-UserId'],
}))

// In a real app, these would come from env vars
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const PROXY_SECRET = process.env.PROXY_SECRET || 'dev-proxy-secret'
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'dev-admin-secret'

const consentManager = new ConsentManager(REDIS_URL)

app.get('/health', async (c) => {
  return c.json({ status: 'ok', redis: 'connected' })
})

/**
 * Consent Management API
 */
app.put('/consent/:userId', async (c) => {
  const auth = c.req.header('Authorization')
  if (auth !== `Bearer ${ADMIN_SECRET}`) return c.json({ error: 'Unauthorized' }, 403)

  const userId = c.req.param('userId')
  const body = await c.req.json()
  
  const result = ConsentStateSchema.safeParse({ ...body, userId })
  if (!result.success) return c.json({ error: result.error }, 400)

  await consentManager.setConsent(userId, result.data)
  return c.json({ status: 'saved' })
})

app.get('/consent/:userId', async (c) => {
  const auth = c.req.header('Authorization')
  if (auth !== `Bearer ${ADMIN_SECRET}`) return c.json({ error: 'Unauthorized' }, 403)

  const userId = c.req.param('userId')
  const consent = await consentManager.getConsent(userId)
  return c.json(consent)
})

/**
 * Analytics Ingestion API
 */
app.post('/ingest/:destination', async (c) => {
  const auth = c.req.header('Authorization')
  if (auth !== `Bearer ${PROXY_SECRET}`) return c.json({ error: 'Unauthorized' }, 403)

  const destination = c.req.param('destination')
  const userId = c.req.header('X-Consent-UserId') || 'anonymous'
  const payload = await c.req.json()

  // 1. Resolve Consent
  const consent = await consentManager.getConsent(userId)

  // 2. Resolve Rule
  const rule = getDestinationRule(destination) || getDefaultRule(destination)

  // 3. Check Category Consent
  if (!consentManager.hasConsent(consent, rule.category)) {
    console.log(`[ConsentGuard] Blocked ${destination} for user ${userId} (Category: ${rule.category})`)
    return c.body(null, 204)
  }

  // 4. Scrub Payload
  const scrubbed = scrubPayload(payload, rule)

  // 5. Forward
  const targetUrl = c.req.header('X-Original-Url') || rule.upstreamUrl
  if (!targetUrl) {
    console.error(`[ConsentGuard] No target URL found for ${destination}`)
    return c.json({ error: 'Missing target URL' }, 400)
  }

  console.log(`[ConsentGuard] Forwarding scrubbed ${destination} for user ${userId} to ${targetUrl}`)

  try {
    const response = await fetch(targetUrl, {
      method: c.req.method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': c.req.header('User-Agent') || 'ConsentGuard Proxy',
      },
      body: JSON.stringify(scrubbed),
    })

    console.log(`[ConsentGuard] Upstream ${destination} responded with ${response.status}`)
    
    // Return the same status and body if possible, or just 204
    return c.body(null, response.status as any)
  } catch (error) {
    console.error(`[ConsentGuard] Failed to forward to ${destination}:`, error)
    return c.json({ error: 'Upstream connection failed' }, 502)
  }
})

const port = process.env.PORT ? parseInt(process.env.PORT) : defaultConfig.proxy.port
console.log(`ConsentGuard Proxy running on port ${port}`)

serve({
  fetch: app.fetch,
  port
})

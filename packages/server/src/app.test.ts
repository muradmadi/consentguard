import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from './app'
import { MemoryStorageProvider } from './engine/storage'

const DEV_ENV = {
  NODE_ENV: 'test',
  ADMIN_SECRET: 'test-admin',
  SLUICE_DEFAULT_CONSENT: 'deny',
  BUFFER_PENDING: 'false',
}

function withAllowedOrigin(origin: string, base?: HeadersInit): HeadersInit {
  return { ...(base || {}), Origin: origin }
}

describe('Sluice server', () => {
  let storage: MemoryStorageProvider

  beforeEach(() => {
    storage = new MemoryStorageProvider()
  })

  describe('health', () => {
    it('returns storage class name', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/health')
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ status: 'ok', storage: 'MemoryStorageProvider' })
    })
  })

  describe('admin consent endpoints', () => {
    it('rejects PUT /consent/:userId without admin bearer', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/consent/user-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purposes: { analytics: true }, timestamp: Date.now() }),
      })
      expect(res.status).toBe(403)
    })

    it('accepts and returns consent when authorized', async () => {
      const app = createApp(storage, DEV_ENV)
      const putRes = await app.request('/consent/user-1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({
          purposes: { analytics: true, marketing: false },
          timestamp: Date.now(),
        }),
      })
      expect(putRes.status).toBe(200)
      const getRes = await app.request('/consent/user-1', {
        headers: { Authorization: 'Bearer test-admin' },
      })
      const data = (await getRes.json()) as any
      expect(data.purposes.analytics).toBe(true)
      expect(data.purposes.marketing).toBe(false)
    })
  })

  describe('public /consent/self', () => {
    it('persists consent using the X-Consent-UserId header when no cookie is present', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/consent/self', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'browser-user-1' },
        body: JSON.stringify({ purposes: { analytics: true } }),
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      expect(data.userId).toBe('browser-user-1')

      const stored = await storage.get('consent:browser-user-1')
      const parsed = JSON.parse(stored!)
      expect(parsed.purposes.analytics).toBe(true)
      expect(parsed.purposes.necessary).toBe(true)
    })

    it('mints a cookie when the browser has no user id', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/consent/self', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purposes: {} }),
      })
      expect(res.status).toBe(200)
      const setCookie = res.headers.get('Set-Cookie')
      expect(setCookie).toMatch(/cuid=/)
    })
  })

  describe('/ingest origin allowlist', () => {
    it('rejects requests whose Origin is not in the allowlist', async () => {
      const app = createApp(storage, {
        ...DEV_ENV,
        SLUICE_ALLOWED_ORIGINS: 'https://app.example.com',
      })
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: withAllowedOrigin('https://evil.example.com', {
          'Content-Type': 'application/json',
          'X-Consent-UserId': 'u1',
        }),
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('accepts requests from an allowed origin', async () => {
      const app = createApp(storage, {
        ...DEV_ENV,
        SLUICE_ALLOWED_ORIGINS: 'https://app.example.com',
      })
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: withAllowedOrigin('https://app.example.com', {
          'Content-Type': 'application/json',
          'X-Consent-UserId': 'u1',
        }),
        body: JSON.stringify({}),
      })
      // Consent is denied by default (no state), so we expect 204 (blocked)
      // rather than 403 (origin rejection). That means we passed the allowlist.
      expect(res.status).toBe(204)
    })

    it('allows any origin when the allowlist is empty (dev mode)', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: withAllowedOrigin('https://anything.example.com', {
          'Content-Type': 'application/json',
          'X-Consent-UserId': 'u1',
        }),
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)
    })
  })

  describe('/ingest consent enforcement', () => {
    it('blocks (204) when no consent record exists and buffering is off', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'no-consent-user' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)
    })

    it('buffers (202) when buffering is enabled and the user has no consent record', async () => {
      const app = createApp(storage, { ...DEV_ENV, BUFFER_PENDING: 'true' })
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'pending-user' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(202)
    })

    it('resolves user id from the cuid cookie', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: 'cuid=cookie-user' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)
    })

    it('drops requests when no user id can be resolved', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)
    })
  })

  /**
   * The audit record is the product's only evidentiary artifact. These tests
   * exist because it used to be assembled from the declared rule rather than
   * from the payload, so it reported scrubbing that never happened.
   */
  describe('/ingest audit evidence', () => {
    const SINK = 'https://sink.example.com/collect'
    let upstream: ReturnType<typeof vi.fn>
    let realFetch: typeof globalThis.fetch

    /** A destination with no adapter, so the generic passthrough path runs. */
    async function seed(app: ReturnType<typeof createApp>) {
      await app.request('/api/rules/testvendor', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({
          id: 'testvendor',
          category: 'analytics',
          endpoints: [],
          upstreamUrl: SINK,
          transformations: [
            { path: 'email', action: 'strip' },
            { path: 'phone', action: 'hash' },
          ],
        }),
      })
      await app.request('/consent/clean-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({ purposes: { analytics: true }, timestamp: Date.now() }),
      })
    }

    function send(app: ReturnType<typeof createApp>, payload: unknown) {
      return app.request('/ingest/testvendor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'clean-user' },
        body: JSON.stringify(payload),
      })
    }

    async function latestAudit(app: ReturnType<typeof createApp>) {
      const res = await app.request('/audit', { headers: { Authorization: 'Bearer test-admin' } })
      return ((await res.json()) as any[])[0]
    }

    beforeEach(() => {
      realFetch = globalThis.fetch
      upstream = vi.fn(async () => new Response(null, { status: 200 }))
      globalThis.fetch = upstream as unknown as typeof fetch
    })

    afterEach(() => {
      globalThis.fetch = realFetch
    })

    it('reports no transformations when the declared fields are absent', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await send(app, { event: 'page_view', plan: 'pro' })
      expect(res.status).toBe(204)

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('forwarded')
      expect(entry.transformations).toEqual([])
    })

    it('reports exactly the transformations that fired', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await send(app, { event: 'purchase', email: 'alice@example.com', phone: '555-1234' })

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('forwarded')
      expect(entry.transformations).toEqual([
        { path: 'email', action: 'strip', matched: 1 },
        { path: 'phone', action: 'hash', matched: 1 },
      ])
    })

    it('forwards a payload with the personal data actually removed', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await send(app, { event: 'purchase', email: 'alice@example.com', phone: '555-1234' })

      expect(upstream).toHaveBeenCalledTimes(1)
      const body = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
      expect(body.email).toBeUndefined()
      expect(body.phone).toMatch(/^[0-9a-f]{64}$/)
      expect(body.event).toBe('purchase')
    })

    it('never writes the removed value into the audit record', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await send(app, { email: 'alice@example.com', phone: '555-1234' })

      const entry = await latestAudit(app)
      expect(JSON.stringify(entry)).not.toContain('alice@example.com')
    })

    it('records failed, not forwarded, when the upstream rejects', async () => {
      upstream.mockResolvedValue(new Response(null, { status: 500 }))
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await send(app, { email: 'alice@example.com' })
      expect(res.status).toBe(502)

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('failed')
      expect(entry.reason).toBe('upstream_status:500')
      expect(entry.transformations).toEqual([{ path: 'email', action: 'strip', matched: 1 }])
    })

    it('records failed when the upstream is unreachable', async () => {
      upstream.mockRejectedValue(new Error('connection refused'))
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await send(app, { event: 'page_view' })
      expect(res.status).toBe(502)
      expect((await latestAudit(app)).decision).toBe('failed')
    })

    it('removes personal data from a field no rule declared', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await send(app, {
        event: 'purchase',
        custom_field_7: 'alice@example.com',
        client_ip: '203.0.113.9',
      })
      expect(res.status).toBe(204)

      const body = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
      expect(body.custom_field_7).toMatch(/^[0-9a-f]{64}$/)
      expect(body.client_ip).toBeUndefined()
      expect(body.event).toBe('purchase')

      const entry = await latestAudit(app)
      expect(entry.transformations).toEqual([
        { path: 'custom_field_7', action: 'hash', matched: 1, detector: 'email' },
        { path: 'client_ip', action: 'strip', matched: 1, detector: 'ipv4' },
      ])
    })

    it('keeps the audit free of the value the scan removed', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await send(app, { referrer: 'https://shop.test/?email=alice@example.com' })

      const entry = await latestAudit(app)
      expect(JSON.stringify(entry)).not.toContain('alice@example.com')
      expect(entry.transformations).toEqual([
        { path: 'referrer', action: 'redact', matched: 1, detector: 'email' },
      ])
    })

    it('forwards the data untouched when the scan is switched off', async () => {
      const app = createApp(storage, { ...DEV_ENV, SLUICE_DETECTORS: 'off' })
      await seed(app)

      await send(app, { custom_field_7: 'alice@example.com' })

      const body = JSON.parse((upstream.mock.calls[0][1] as RequestInit).body as string)
      expect(body.custom_field_7).toBe('alice@example.com')
      expect((await latestAudit(app)).transformations).toEqual([])
    })

    it('refuses to forward a body it cannot parse and therefore cannot scrub', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await app.request('/ingest/testvendor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Consent-UserId': 'clean-user',
        },
        body: 'email=alice@example.com&event=page_view',
      })

      expect(res.status).toBe(204)
      expect(upstream).not.toHaveBeenCalled()
      const entry = await latestAudit(app)
      expect(entry.decision).toBe('blocked')
      expect(entry.reason).toBe('unscrubbable_payload')
    })
  })

  describe('CMP webhook', () => {
    it('rejects unauthorized webhooks', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/webhooks/cookiebot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: 'u1', statistics: true }),
      })
      expect(res.status).toBe(401)
    })

    it('accepts Cookiebot payloads with the shared secret', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/webhooks/cookiebot?secret=test-admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: 'webhook-user',
          statistics: true,
          marketing: false,
          necessary: true,
          region: 'EU',
        }),
      })
      expect(res.status).toBe(200)
      const data = (await res.json()) as any
      expect(data.userId).toBe('webhook-user')
    })
  })
})

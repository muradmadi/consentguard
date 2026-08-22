import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createApp } from './app'
import { MemoryStorageProvider } from './engine/storage'

const DEV_ENV = {
  NODE_ENV: 'test',
  ADMIN_SECRET: 'test-admin',
  SLUICE_DEFAULT_CONSENT: 'deny',
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

  /**
   * `POST /consent/self` let the browser assert its own consent, which is the
   * escalation step that made the proxy an open forwarder: grant marketing for
   * an id you invented, then name any URL you like. Consent is an input from an
   * external CMP, never something the measured page says about itself.
   */
  describe('browser-asserted consent', () => {
    it('has no public consent endpoint at all', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/consent/self', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'attacker' },
        body: JSON.stringify({ purposes: { marketing: true } }),
      })
      expect(res.status).toBe(404)
      expect(await storage.get('consent:attacker')).toBeNull()
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

    /**
     * A missing Origin used to pass, on the grounds that non-browser callers
     * are fine. Every tool that is not a browser omits the header, so the
     * allowlist stopped browsers and nothing else.
     */
    it('rejects a request with no Origin at all once an allowlist is configured', async () => {
      const app = createApp(storage, {
        ...DEV_ENV,
        SLUICE_ALLOWED_ORIGINS: 'https://app.example.com',
      })
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'u1' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(403)
    })

    it('allows a request with no Origin while the allowlist is empty (dev mode)', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'u1' },
        body: JSON.stringify({}),
      })
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
    it('blocks (204) when no consent record exists', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'no-consent-user' },
        body: JSON.stringify({}),
      })
      expect(res.status).toBe(204)
    })

    /**
     * Buffering stored the full contents of tracking events for users who had
     * given no consent, then replayed them. There is no lawful basis to hold
     * that payload, and it is not firewall behaviour.
     */
    it('blocks a user with no consent record instead of storing their payload', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'pending-user' },
        body: JSON.stringify({ email: 'alice@example.com' }),
      })
      expect(res.status).toBe(204)

      const dump = JSON.stringify(await storage.lrange('sluice_buffer:pending-user', 0, -1))
      expect(dump).not.toContain('alice@example.com')
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
          // Declared endpoints are the egress allowlist: a forward may only
          // address a host this rule names, or its own upstreamUrl.
          endpoints: ['api.vendor.test'],
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

    it('scrubs the query string of the url it forwards to, not just the body', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await app.request('/ingest/testvendor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Consent-UserId': 'clean-user',
          'X-Original-Url':
            'https://api.vendor.test/track?em=alice@example.com&ip=203.0.113.9&e=purchase',
        },
        body: JSON.stringify({ event: 'purchase' }),
      })
      expect(res.status).toBe(204)

      const sent = new URL(String(upstream.mock.calls[0][0]))
      expect(sent.searchParams.get('em')).toMatch(/^[0-9a-f]{64}$/)
      expect(sent.searchParams.has('ip')).toBe(false)
      expect(sent.searchParams.get('e')).toBe('purchase')

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('forwarded')
      expect(entry.transformations).toEqual([
        { path: '?em', action: 'hash', matched: 1, detector: 'email' },
        { path: '?ip', action: 'strip', matched: 1, detector: 'ipv4' },
      ])
    })

    it('never lets the query string value reach the audit record', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await app.request('/ingest/testvendor', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Consent-UserId': 'clean-user',
          'X-Original-Url': 'https://api.vendor.test/track?em=alice@example.com',
        },
        body: JSON.stringify({ event: 'purchase' }),
      })

      expect(JSON.stringify(await latestAudit(app))).not.toContain('alice@example.com')
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

  /**
   * `?original=` names the URL the browser was heading to, and the proxy used
   * to forward there without ever checking it against the destination rule. Two
   * unauthenticated steps on stock configuration reached any host the server
   * could route to — cloud metadata, internal admin panels — and the audit
   * recorded it as a clean forward to the vendor. The response never returns to
   * the caller, so it was a blind exfiltration and scanning primitive.
   */
  describe('/ingest egress allowlist', () => {
    let upstream: ReturnType<typeof vi.fn>
    let realFetch: typeof globalThis.fetch

    async function seed(app: ReturnType<typeof createApp>) {
      await app.request('/api/rules/testpixel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({
          id: 'testpixel',
          category: 'marketing',
          endpoints: ['pixel.vendor.test'],
          transformations: [],
        }),
      })
      await app.request('/consent/attacker', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({ purposes: { marketing: true }, timestamp: Date.now() }),
      })
    }

    function pixelTo(app: ReturnType<typeof createApp>, original: string) {
      return app.request(`/ingest/testpixel?cuid=attacker&original=${encodeURIComponent(original)}`)
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

    it('refuses a host the destination rule does not declare', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await pixelTo(app, 'https://sink.attacker.test/pwned?via=default-config')
      expect(res.status).toBe(204)
      expect(upstream).not.toHaveBeenCalled()

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('blocked')
      expect(entry.reason).toBe('host_not_declared')
    })

    it('refuses an internal address even before the allowlist is consulted', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await pixelTo(app, 'http://127.0.0.1:4111/pwned')
      expect(res.status).toBe(204)
      expect(upstream).not.toHaveBeenCalled()
      expect((await latestAudit(app)).reason).toBe('host_is_internal_address')
    })

    it.each([
      ['the cloud metadata address', 'http://169.254.169.254/latest/meta-data/'],
      ['a private range', 'http://10.1.2.3/admin'],
      ['loopback by name', 'http://localhost:8080/admin'],
      ['an internal hostname', 'http://redis.internal:6379/'],
      ['IPv6 loopback', 'http://[::1]:9200/_cluster/health'],
    ])('refuses %s', async (_label, target) => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await pixelTo(app, target)
      expect(upstream).not.toHaveBeenCalled()
      expect((await latestAudit(app)).decision).toBe('blocked')
    })

    it('is not fooled by a declared domain that is only a substring of the host', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await pixelTo(app, 'https://pixel.vendor.test.attacker.test/tr?id=1')
      expect(upstream).not.toHaveBeenCalled()
      expect((await latestAudit(app)).reason).toBe('host_not_declared')
    })

    it('is not fooled by a declared domain in the userinfo of the URL', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await pixelTo(app, 'https://pixel.vendor.test@attacker.test/tr?id=1')
      expect(upstream).not.toHaveBeenCalled()
      expect((await latestAudit(app)).reason).toBe('host_not_declared')
    })

    it('still forwards to a subdomain of a declared endpoint', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await pixelTo(app, 'https://edge.pixel.vendor.test/tr?ev=Purchase')
      expect(res.status).toBe(204)
      expect(upstream).toHaveBeenCalledTimes(1)
      expect((await latestAudit(app)).decision).toBe('forwarded')
    })

    it('does not follow a redirect the vendor answers with', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await pixelTo(app, 'https://pixel.vendor.test/tr?ev=Purchase')
      expect((upstream.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
    })
  })

  /**
   * The same counters /api/stats requires a bearer for: which vendors a site
   * uses, and how much of its traffic is being blocked.
   */
  describe('/metrics access', () => {
    it('refuses an unauthenticated scrape', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/metrics?format=prometheus')
      expect(res.status).toBe(403)
    })

    it('answers the admin bearer', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer test-admin' },
      })
      expect(res.status).toBe(200)
    })

    it('answers a scrape token when the operator has configured one', async () => {
      const app = createApp(storage, { ...DEV_ENV, SLUICE_METRICS_TOKEN: 'scrape-me' })
      const res = await app.request('/metrics', {
        headers: { Authorization: 'Bearer scrape-me' },
      })
      expect(res.status).toBe(200)
    })

    it('does not accept a scrape token that was never configured', async () => {
      const app = createApp(storage, DEV_ENV)
      const res = await app.request('/metrics', { headers: { Authorization: 'Bearer ' } })
      expect(res.status).toBe(403)
    })
  })

  /**
   * `/ingest` is public and unauthenticated, and a beacon is a few hundred
   * bytes. An unbounded read is memory any caller can spend.
   */
  describe('/ingest body cap', () => {
    async function seed(app: ReturnType<typeof createApp>) {
      await app.request('/consent/big-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({ purposes: { analytics: true }, timestamp: Date.now() }),
      })
    }

    it('refuses a body larger than the configured maximum', async () => {
      const app = createApp(storage, { ...DEV_ENV, SLUICE_MAX_BODY_BYTES: '512' })
      await seed(app)

      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'big-user' },
        body: JSON.stringify({ pad: 'x'.repeat(2048) }),
      })
      expect(res.status).toBe(413)

      const audit = await app.request('/audit', {
        headers: { Authorization: 'Bearer test-admin' },
      })
      expect(((await audit.json()) as any[])[0].reason).toBe('payload_too_large')
    })

    it('accepts a body inside the maximum', async () => {
      const app = createApp(storage, { ...DEV_ENV, SLUICE_MAX_BODY_BYTES: '512' })
      await seed(app)

      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'big-user' },
        body: JSON.stringify({ pad: 'x'.repeat(64) }),
      })
      expect(res.status).not.toBe(413)
    })

    it('refuses an oversized body that understates its Content-Length', async () => {
      const app = createApp(storage, { ...DEV_ENV, SLUICE_MAX_BODY_BYTES: '512' })
      await seed(app)

      const res = await app.request('/ingest/ga4', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Consent-UserId': 'big-user',
          'Content-Length': '10',
        },
        body: JSON.stringify({ pad: 'x'.repeat(2048) }),
      })
      expect(res.status).toBe(413)
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

  describe('/ingest pixel transport', () => {
    const PIXEL_RULE = {
      id: 'testpixel',
      category: 'marketing',
      endpoints: ['pixel.vendor.test'],
      transformations: [],
    }
    let upstream: ReturnType<typeof vi.fn>
    let realFetch: typeof globalThis.fetch

    async function seed(app: ReturnType<typeof createApp>) {
      await app.request('/api/rules/testpixel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify(PIXEL_RULE),
      })
      await app.request('/consent/pixel-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({ purposes: { marketing: true }, timestamp: Date.now() }),
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

    /**
     * An <img> beacon is a GET with no body: the whole payload is the query
     * string. Before the pixel branch existed this was refused as an
     * unscrubbable payload, so the vendor never received the event at all.
     */
    it('forwards a bodyless pixel, scrubbed, instead of refusing it', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const original =
        'https://pixel.vendor.test/tr?id=42&ev=Purchase&em=alice@example.com&ip=203.0.113.9'
      const res = await app.request(
        `/ingest/testpixel?cuid=pixel-user&original=${encodeURIComponent(original)}`,
      )
      expect(res.status).toBe(204)

      expect(upstream).toHaveBeenCalledTimes(1)
      const sent = new URL(String(upstream.mock.calls[0][0]))
      expect(sent.searchParams.get('em')).toMatch(/^[0-9a-f]{64}$/)
      expect(sent.searchParams.has('ip')).toBe(false)
      expect(sent.searchParams.get('ev')).toBe('Purchase')
      expect(sent.searchParams.get('id')).toBe('42')
      expect((upstream.mock.calls[0][1] as RequestInit).method).toBe('GET')

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('forwarded')
      expect(entry.transformations).toEqual([
        { path: '?em', action: 'hash', matched: 1, detector: 'email' },
        { path: '?ip', action: 'strip', matched: 1, detector: 'ipv4' },
      ])
    })

    it('refuses a bodyless request with no url to forward to', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await app.request('/ingest/testpixel?cuid=pixel-user')
      expect(res.status).toBe(204)
      expect(upstream).not.toHaveBeenCalled()

      const entry = await latestAudit(app)
      expect(entry.decision).toBe('blocked')
    })

    it('keeps the query string out of the request log', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)
      const logged: string[] = []
      const spy = vi.spyOn(console, 'log').mockImplementation((...args) => {
        logged.push(args.join(' '))
      })

      const original = 'https://pixel.vendor.test/tr?em=alice@example.com'
      await app.request(
        `/ingest/testpixel?cuid=pixel-user&original=${encodeURIComponent(original)}`,
      )
      spy.mockRestore()

      const line = logged.join('\n')
      expect(line).toContain('/ingest/testpixel')
      // The value arrives percent-encoded, so decode before looking for it —
      // `alice%40example.com` in a log file is just as much of a leak.
      expect(decodeURIComponent(line)).not.toContain('alice@example.com')
      expect(line).not.toContain('original=')
    })
  })
})

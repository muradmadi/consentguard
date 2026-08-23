import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { createApp } from './app'
import { MemoryStorageProvider } from './engine/storage'
import { FileAuditSink } from './engine/audit/sink/file'

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
          transport: 'json',
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
      return ((await res.json()) as any).records[0]
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
        { path: 'phone', action: 'hash', mode: 'pseudonymize', matched: 1 },
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
        {
          path: 'custom_field_7',
          action: 'hash',
          mode: 'pseudonymize',
          matched: 1,
          detector: 'email',
        },
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
        { path: '?em', action: 'hash', mode: 'pseudonymize', matched: 1, detector: 'email' },
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
          transport: 'pixel',
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
      return ((await res.json()) as any).records[0]
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
      expect(((await audit.json()) as any).records[0].reason).toBe('payload_too_large')
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
      transport: 'pixel',
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
      return ((await res.json()) as any).records[0]
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
        { path: '?em', action: 'hash', mode: 'pseudonymize', matched: 1, detector: 'email' },
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

  /**
   * A destination this build cannot serve is refused before anything is built.
   *
   * The case that matters is an encoded payload — Mixpanel's base64 `data`, a
   * Hotjar recording envelope — where neither scrub pass can read the contents.
   * Forwarding one produced a truthful audit record saying nothing was removed,
   * which is the same defect as an audit built from a rule's declarations: the
   * evidence was accurate and the payload still carried whatever was in it.
   */
  describe('/ingest destinations this build cannot serve', () => {
    const OPAQUE_RULE = {
      id: 'testopaque',
      category: 'analytics',
      endpoints: ['sink.example.com'],
      transport: 'opaque',
      upstreamUrl: 'https://sink.example.com/collect',
      transformations: [],
    }
    let upstream: ReturnType<typeof vi.fn>
    let realFetch: typeof globalThis.fetch

    async function seed(app: ReturnType<typeof createApp>, rule: unknown = OPAQUE_RULE) {
      await app.request(`/api/rules/${(rule as any).id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify(rule),
      })
      await app.request('/consent/opaque-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({ purposes: { analytics: true }, timestamp: Date.now() }),
      })
    }

    async function latestAudit(app: ReturnType<typeof createApp>) {
      const res = await app.request('/audit', { headers: { Authorization: 'Bearer test-admin' } })
      return ((await res.json()) as any).records[0]
    }

    beforeEach(() => {
      realFetch = globalThis.fetch
      upstream = vi.fn(async () => new Response(null, { status: 200 }))
      globalThis.fetch = upstream as unknown as typeof fetch
    })

    afterEach(() => {
      globalThis.fetch = realFetch
    })

    it('does not forward an opaque payload it has no adapter for', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const res = await app.request('/ingest/testopaque', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'opaque-user' },
        body: JSON.stringify({ data: 'W3siZXZlbnQiOiJ4In1d' }),
      })

      expect(res.status).toBe(204)
      expect(upstream).not.toHaveBeenCalled()
    })

    it('records why, because a refusal is evidence too', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      await app.request('/ingest/testopaque', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'opaque-user' },
        body: JSON.stringify({ data: 'W3siZXZlbnQiOiJ4In1d' }),
      })

      const entry = await latestAudit(app)
      expect(entry).toMatchObject({
        destination: 'testopaque',
        decision: 'blocked',
        reason: 'destination_unsupported',
      })
    })

    it('refuses a bodyless pixel for the same destination, not just a body', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app)

      const original = 'https://sink.example.com/collect?data=W3siZXZlbnQiOiJ4In1d'
      await app.request(
        `/ingest/testopaque?cuid=opaque-user&original=${encodeURIComponent(original)}`,
      )

      expect(upstream).not.toHaveBeenCalled()
      expect((await latestAudit(app)).reason).toBe('destination_unsupported')
    })

    it('still forwards a destination whose transport both passes can read', async () => {
      const app = createApp(storage, DEV_ENV)
      await seed(app, { ...OPAQUE_RULE, id: 'testreadable', transport: 'json' })

      const res = await app.request('/ingest/testreadable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'opaque-user' },
        body: JSON.stringify({ event: 'page_view' }),
      })

      expect(res.status).toBe(204)
      expect(upstream).toHaveBeenCalledTimes(1)
      expect((await latestAudit(app)).decision).toBe('forwarded')
    })
  })
  /**
   * The record is half the claim: nothing leaves carrying personal data, *and*
   * there is a per-request record proving it. These cover the half that has to
   * still be there next quarter — durable, queryable, exportable, and provably
   * unedited.
   */
  describe('durable audit record', () => {
    const SINK = 'https://sink.example.com/collect'
    let dir: string
    let auditSink: FileAuditSink
    let upstream: ReturnType<typeof vi.fn>
    let realFetch: typeof globalThis.fetch

    function app(env: Record<string, string> = {}) {
      return createApp(storage, { ...DEV_ENV, ...env }, { auditSink })
    }

    // A registry destination with no adapter, because /api/rule-health can only
    // report on ids the registry knows — it joins the audit against
    // RuleManager.getAllRules(), and StorageProvider cannot enumerate keys.
    async function seed(instance: ReturnType<typeof createApp>) {
      await instance.request('/api/rules/amplitude', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({
          id: 'amplitude',
          category: 'analytics',
          endpoints: ['sink.example.com'],
          transport: 'json',
          upstreamUrl: SINK,
          transformations: [
            { path: 'email', action: 'strip' },
            { path: 'never_sent', action: 'strip' },
          ],
        }),
      })
      await instance.request('/consent/clean-user', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
        body: JSON.stringify({ purposes: { analytics: true }, timestamp: Date.now() }),
      })
    }

    function send(instance: ReturnType<typeof createApp>, payload: unknown) {
      return instance.request('/ingest/amplitude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'clean-user' },
        body: JSON.stringify(payload),
      })
    }

    async function get(instance: ReturnType<typeof createApp>, path: string) {
      return instance.request(path, { headers: { Authorization: 'Bearer test-admin' } })
    }

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'sluice-app-audit-'))
      auditSink = new FileAuditSink({ dir, retentionDays: 90 })
      realFetch = globalThis.fetch
      upstream = vi.fn(async () => new Response(null, { status: 200 }))
      globalThis.fetch = upstream as unknown as typeof fetch
    })

    afterEach(async () => {
      globalThis.fetch = realFetch
      await rm(dir, { recursive: true, force: true })
    })

    it('writes every decision to disk, not only to the cache', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })

      const [file] = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
      const lines = (await readFile(join(dir, file), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(1)
      expect(JSON.parse(lines[0])).toMatchObject({ destination: 'amplitude', seq: 0 })
    })

    it('survives the process that wrote it', async () => {
      const first = app()
      await seed(first)
      await send(first, { email: 'alice@example.com' })

      // A second app over the same directory: new process, same evidence.
      auditSink = new FileAuditSink({ dir, retentionDays: 90 })
      const restarted = app()
      const page = (await (await get(restarted, '/audit')).json()) as any
      expect(page.records).toHaveLength(1)
    })

    it('filters by destination, decision and detector', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })
      await send(instance, { contact: 'bob@example.com' })
      await instance.request('/ingest/amplitude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'no-consent-user' },
        body: JSON.stringify({}),
      })

      const forwarded = (await (await get(instance, '/audit?decision=forwarded')).json()) as any
      expect(forwarded.records).toHaveLength(2)

      const blocked = (await (await get(instance, '/audit?decision=blocked')).json()) as any
      expect(blocked.records.map((r: any) => r.reason)).toEqual(['consent_missing'])

      // `contact` is not a declared path; the value scan is what caught it.
      const detected = (await (await get(instance, '/audit?detector=email')).json()) as any
      expect(detected.records).toHaveLength(1)
      expect(detected.records[0].transformations[0].path).toBe('contact')

      const elsewhere = (await (await get(instance, '/audit?destination=ga4')).json()) as any
      expect(elsewhere.records).toEqual([])
    })

    it('refuses a filter it cannot honour rather than silently ignoring it', async () => {
      const instance = app()
      expect((await get(instance, '/audit?decision=forwaded')).status).toBe(400)
      expect((await get(instance, '/audit?detector=eyecolour')).status).toBe(400)
      expect((await get(instance, '/audit?from=yesterday')).status).toBe(400)
      expect((await get(instance, '/audit?limit=0')).status).toBe(400)
    })

    it('pages newest first', async () => {
      const instance = app()
      await seed(instance)
      for (let i = 0; i < 3; i++) await send(instance, { n: i })

      const first = (await (await get(instance, '/audit?limit=2')).json()) as any
      expect(first.records.map((r: any) => r.seq)).toEqual([2, 1])

      const next = (await (
        await get(instance, `/audit?limit=2&cursor=${first.nextCursor}`)
      ).json()) as any
      expect(next.records.map((r: any) => r.seq)).toEqual([0])
      expect(next.nextCursor).toBeNull()
    })

    it('exports the record as CSV and NDJSON, hashes included', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })

      const csv = await get(instance, '/audit?format=csv')
      expect(csv.headers.get('Content-Type')).toContain('text/csv')
      expect(csv.headers.get('Content-Disposition')).toContain('sluice-audit.csv')
      const rows = (await csv.text()).trim().split('\n')
      expect(rows[0]).toBe(
        'seq,timestamp,userId,destination,decision,reason,purposesRequired,purposesGranted,transformations,prevHash,hash',
      )
      expect(rows[1]).toContain('amplitude')
      expect(rows[1]).not.toContain('alice@example.com')

      const ndjson = await get(instance, '/audit?format=ndjson')
      expect(ndjson.headers.get('Content-Type')).toContain('application/x-ndjson')
      expect(JSON.parse((await ndjson.text()).trim())).toMatchObject({ seq: 0 })
    })

    it('verifies the chain, and stops verifying once a record is edited', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })
      await send(instance, { email: 'bob@example.com' })

      expect(await (await get(instance, '/audit/verify')).json()).toMatchObject({
        status: 'intact',
        checked: 2,
      })

      const [file] = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
      const path = join(dir, file)
      const edited = (await readFile(path, 'utf8')).replace(
        '"decision":"forwarded"',
        '"decision":"blocked"',
      )
      await writeFile(path, edited)

      auditSink = new FileAuditSink({ dir, retentionDays: 90 })
      const result = (await (await get(app(), '/audit/verify')).json()) as any
      expect(result.status).toBe('broken')
      expect(result.brokenAt).toBe(0)
    })

    it('reports health it has actually measured', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })

      const health = (await (await get(instance, '/api/health')).json()) as any
      expect(health).toMatchObject({
        status: 'ok',
        storage: { kind: 'MemoryStorageProvider', ok: true, error: null },
        audit: {
          configured: true,
          healthy: true,
          entries: 1,
          retentionDays: 90,
          evidenceAvailable: true,
        },
      })
      expect(health.audit.location).toBe(dir)
      expect(health.audit.head.hash).toMatch(/^[0-9a-f]{64}$/)
      expect(typeof health.storage.latencyMs).toBe('number')
    })

    it('reports degraded storage rather than asserting health', async () => {
      vi.spyOn(storage, 'get').mockRejectedValue(new Error('redis down'))

      const health = (await (await get(app(), '/api/health')).json()) as any
      expect(health.status).toBe('degraded')
      expect(health.storage.ok).toBe(false)
      expect(health.storage.error).toBe('redis down')

      const publicHealth = (await (await app().request('/health')).json()) as any
      expect(publicHealth).toMatchObject({ status: 'degraded', storageOk: false })
    })

    it('names the declared transformations that have never fired', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })

      const report = (await (await get(instance, '/api/rule-health')).json()) as any
      const vendor = report.destinations.find((d: any) => d.destination === 'amplitude')

      expect(vendor.declared).toEqual([
        { path: 'email', action: 'strip', matched: 1, lastFiredAt: expect.any(String) },
        { path: 'never_sent', action: 'strip', matched: 0, lastFiredAt: null },
      ])
      expect(report.truncated).toBe(false)
    })

    it('stops forwarding when it can no longer record what it did', async () => {
      const instance = app()
      await seed(instance)

      // Occupy today's segment path so the next append cannot land.
      await mkdir(join(dir, `audit-${new Date().toISOString().slice(0, 10)}.ndjson`))

      const res = await send(instance, { email: 'alice@example.com' })

      // Opaque to the caller either way: a vendor SDK must not be able to tell.
      expect(res.status).toBe(204)
      expect(upstream).not.toHaveBeenCalled()

      const health = (await (await get(instance, '/api/health')).json()) as any
      expect(health.audit.evidenceAvailable).toBe(false)
      expect(health.status).toBe('degraded')

      // A firewall refusing every request is not healthy, even to a public probe.
      const publicHealth = (await (await instance.request('/health')).json()) as any
      expect(publicHealth).toMatchObject({ status: 'degraded', evidence: 'unavailable' })
    })

    it('keeps forwarding when the operator has accepted the risk', async () => {
      const instance = app({ SLUICE_AUDIT_REQUIRED: 'false' })
      await seed(instance)
      await mkdir(join(dir, `audit-${new Date().toISOString().slice(0, 10)}.ndjson`))

      await send(instance, { email: 'alice@example.com' })

      expect(upstream).toHaveBeenCalled()
    })

    it('does not let the admin token delete the evidence', async () => {
      const instance = app()
      await seed(instance)
      await send(instance, { email: 'alice@example.com' })

      const reset = await instance.request('/api/debug/reset', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer test-admin' },
      })
      expect(await reset.json()).toMatchObject({ auditSinkPreserved: true })

      const [file] = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
      expect((await readFile(join(dir, file), 'utf8')).trim().split('\n')).toHaveLength(1)
      expect(await (await get(instance, '/audit/verify')).json()).toMatchObject({
        status: 'intact',
      })
    })
  })
})

/**
 * A rule override that will not parse is dropped in favour of the registry when
 * it is read, so a `200` on the way in would be a save that changed nothing.
 */
describe('rule override validation', () => {
  const ENV = { NODE_ENV: 'test', ADMIN_SECRET: 'test-admin' }

  function put(app: ReturnType<typeof createApp>, rule: unknown) {
    return app.request('/api/rules/testvendor', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
      body: JSON.stringify(rule),
    })
  }

  it('rejects a match key that names no format, rather than storing it', async () => {
    const app = createApp(new MemoryStorageProvider(), ENV)
    const res = await put(app, {
      category: 'marketing',
      endpoints: ['api.vendor.test'],
      transport: 'pixel',
      transformations: [{ path: 'em', action: 'hash', mode: 'match_key' }],
    })
    expect(res.status).toBe(400)

    const rules = await app.request('/api/rules', {
      headers: { Authorization: 'Bearer test-admin' },
    })
    expect(((await rules.json()) as any).some((r: any) => r.id === 'testvendor')).toBe(false)
  })

  it('saves a well-formed one', async () => {
    const app = createApp(new MemoryStorageProvider(), ENV)
    const res = await put(app, {
      category: 'marketing',
      endpoints: ['api.vendor.test'],
      transport: 'pixel',
      transformations: [{ path: 'em', action: 'hash', mode: 'match_key', normalize: 'email' }],
    })
    expect(res.status).toBe(200)
  })
})

/**
 * Identity, and when a persistent one may be created.
 *
 * The client used to mint a 365-day cookie plus a `localStorage` copy on page
 * load, before any consent record existed — a persistent tracking identifier
 * stored without consent, in a tool whose whole point is compliance. The
 * identifier the browser sends is now session-scoped; making one persistent is
 * this server's decision, and only for a user a consent record already exists
 * for.
 */
describe('identity promotion', () => {
  const ENV = { NODE_ENV: 'test', ADMIN_SECRET: 'test-admin', SLUICE_DEFAULT_CONSENT: 'deny' }
  const SINK = 'https://sink.example.com/collect'
  let storage: MemoryStorageProvider
  let upstream: ReturnType<typeof vi.fn>
  let realFetch: typeof globalThis.fetch

  async function seedRule(app: ReturnType<typeof createApp>) {
    await app.request('/api/rules/testvendor', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
      body: JSON.stringify({
        id: 'testvendor',
        category: 'analytics',
        endpoints: ['sink.example.com'],
        transport: 'json',
        upstreamUrl: SINK,
        transformations: [],
      }),
    })
  }

  async function grantConsent(app: ReturnType<typeof createApp>, userId: string) {
    await app.request(`/consent/${userId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
      body: JSON.stringify({ purposes: { analytics: true }, timestamp: Date.now() }),
    })
  }

  function ingest(app: ReturnType<typeof createApp>, headers: Record<string, string>) {
    return app.request('/ingest/testvendor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ event: 'page_view' }),
    })
  }

  beforeEach(() => {
    storage = new MemoryStorageProvider()
    realFetch = globalThis.fetch
    upstream = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = upstream as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('sets no cookie for a session id with no consent record behind it', async () => {
    const app = createApp(storage, ENV)
    await seedRule(app)

    const res = await ingest(app, { 'X-Consent-UserId': 'session-abc' })
    expect(res.status).toBe(204)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    expect(upstream).not.toHaveBeenCalled()
  })

  it('mints no cookie for a destination consent never had to grant', async () => {
    const app = createApp(storage, ENV)
    // `necessary` is granted unconditionally, so this request forwards without
    // any consent record existing. That is exactly where a persistent
    // identifier must still not be created: nobody has been asked anything.
    await app.request('/api/rules/essential', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
      body: JSON.stringify({
        id: 'essential',
        category: 'necessary',
        endpoints: ['sink.example.com'],
        transport: 'json',
        upstreamUrl: SINK,
        transformations: [],
      }),
    })

    const res = await app.request('/ingest/essential', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Consent-UserId': 'session-abc' },
      body: JSON.stringify({ event: 'page_view' }),
    })

    expect(res.status).toBe(204)
    expect(upstream).toHaveBeenCalled()
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  it('promotes the session id to a first-party cookie once consent exists', async () => {
    const app = createApp(storage, ENV)
    await seedRule(app)
    await grantConsent(app, 'session-abc')

    const res = await ingest(app, { 'X-Consent-UserId': 'session-abc' })
    expect(res.status).toBe(204)
    const cookie = res.headers.get('Set-Cookie')
    expect(cookie).toContain('cuid=session-abc')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Max-Age=31536000')
  })

  it('does not re-issue the cookie to a browser that already holds it', async () => {
    const app = createApp(storage, ENV)
    await seedRule(app)
    await grantConsent(app, 'session-abc')

    const res = await ingest(app, { Cookie: 'cuid=session-abc' })
    expect(res.status).toBe(204)
    expect(res.headers.get('Set-Cookie')).toBeNull()
  })

  /**
   * The cookie is the identity this server promoted; the header is whatever the
   * page says about itself. Once one exists, the page cannot rename the user it
   * is reporting on — and it cannot read the cookie to find out either.
   */
  it('resolves identity from its own cookie ahead of the page-supplied header', async () => {
    const app = createApp(storage, ENV)
    await seedRule(app)
    await grantConsent(app, 'promoted-user')

    const res = await ingest(app, {
      Cookie: 'cuid=promoted-user',
      'X-Consent-UserId': 'a-different-id',
    })
    expect(res.status).toBe(204)
    expect(upstream).toHaveBeenCalled()

    const audit = await app.request('/audit', { headers: { Authorization: 'Bearer test-admin' } })
    expect(((await audit.json()) as any).records[0].userId).toBe('promoted-user')
  })

  it('marks the cookie Secure outside development', async () => {
    const app = createApp(storage, { ...ENV, NODE_ENV: 'production', SLUICE_HASH_SECRET: 'k' })
    await seedRule(app)
    await grantConsent(app, 'session-abc')

    const res = await ingest(app, { 'X-Consent-UserId': 'session-abc' })
    expect(res.headers.get('Set-Cookie')).toContain('Secure')
  })
})

/**
 * `getDefaultRule` used to answer `category: 'necessary'`, which `hasConsent`
 * grants unconditionally — a fail-open branch in a system whose first invariant
 * is fail-closed, reachable through a rule override that will not parse.
 */
describe('a destination whose rule could not be read', () => {
  const ENV = { NODE_ENV: 'test', ADMIN_SECRET: 'test-admin', SLUICE_DEFAULT_CONSENT: 'deny' }
  let storage: MemoryStorageProvider
  let upstream: ReturnType<typeof vi.fn>
  let realFetch: typeof globalThis.fetch

  beforeEach(() => {
    storage = new MemoryStorageProvider()
    realFetch = globalThis.fetch
    upstream = vi.fn(async () => new Response(null, { status: 200 }))
    globalThis.fetch = upstream as unknown as typeof fetch
  })

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('is blocked for consent, not waved through as necessary', async () => {
    const app = createApp(storage, ENV)
    // An override that exists — so the destination is supported — but does not
    // parse, which is what drops the request onto the default rule.
    await storage.set('rule_override:mystery', JSON.stringify({ id: 'mystery', category: 42 }))
    await app.request('/consent/curious-user', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-admin' },
      body: JSON.stringify({
        // Including a purpose named after the category the default rule uses:
        // the refusal has to be unconditional, or a CMP configured with an
        // "unknown" purpose re-opens the branch.
        purposes: { analytics: true, marketing: true, necessary: true, unknown: true },
        timestamp: Date.now(),
      }),
    })

    const res = await app.request('/ingest/mystery', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Consent-UserId': 'curious-user',
        'X-Original-Url': 'https://mystery.example.com/collect?em=alice@example.com',
      },
      body: JSON.stringify({ event: 'page_view' }),
    })

    expect(res.status).toBe(204)
    expect(upstream).not.toHaveBeenCalled()

    const audit = await app.request('/audit', { headers: { Authorization: 'Bearer test-admin' } })
    const entry = ((await audit.json()) as any).records[0]
    expect(entry.decision).toBe('blocked')
    expect(entry.reason).toBe('consent_missing')
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
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

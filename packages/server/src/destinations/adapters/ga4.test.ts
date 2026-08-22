import { describe, it, expect } from 'vitest'
import { ga4Adapter } from './ga4'
import { ga4 as ga4Rule } from '../ga4'
import type { VendorContext } from './types'
import { getServerConfig } from '../../config'
import { createHasher } from '../../engine/transformations/hash'

function makeContext(
  overrides: Partial<VendorContext> & { env?: Record<string, string> } = {},
): VendorContext {
  const env = overrides.env || {
    NODE_ENV: 'test',
    ADMIN_SECRET: 'x',
    GA4_MEASUREMENT_ID: 'G-TEST12345',
    GA4_API_SECRET: 'test-secret',
  }
  return {
    method: 'POST',
    originalUrl:
      overrides.originalUrl ??
      'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST12345&cid=abc.def&en=page_view&ep.page_title=Home&epn.value=42',
    query: overrides.query ?? new URLSearchParams(),
    headers: overrides.headers ?? {},
    jsonBody: overrides.jsonBody ?? null,
    rawBody: overrides.rawBody ?? '',
    rule: overrides.rule ?? ga4Rule,
    serverConfig: overrides.serverConfig ?? getServerConfig(env),
    hasher: overrides.hasher ?? createHasher('test-hash-secret'),
  }
}

describe('GA4 adapter', () => {
  it('skips when GA4 credentials are missing', async () => {
    const ctx = makeContext({
      env: { NODE_ENV: 'test', ADMIN_SECRET: 'x' },
    })
    const result = await ga4Adapter.buildRequest(ctx)
    expect(result).toEqual({ skip: true, reason: expect.stringContaining('GA4') })
  })

  it('translates a gtag beacon into Measurement Protocol JSON', async () => {
    const ctx = makeContext()
    const result = await ga4Adapter.buildRequest(ctx)
    expect(result).not.toBeNull()
    if (!result || 'skip' in result) throw new Error('expected forward')

    expect(result.method).toBe('POST')
    expect(result.url).toContain('measurement_id=G-TEST12345')
    expect(result.url).toContain('api_secret=test-secret')
    expect(result.headers['Content-Type']).toBe('application/json')

    const body = JSON.parse(result.body)
    expect(body.client_id).toBe('abc.def')
    expect(body.events).toHaveLength(1)
    expect(body.events[0].name).toBe('page_view')
    expect(body.events[0].params.page_title).toBe('Home')
    expect(body.events[0].params.value).toBe(42)
  })

  it('hashes an email that appears in event params (rule-driven scrubbing)', async () => {
    const ctx = makeContext({
      originalUrl:
        'https://www.google-analytics.com/g/collect?v=2&tid=G-TEST12345&cid=abc&en=signup&ep.email=alice@example.com',
    })
    const result = await ga4Adapter.buildRequest(ctx)
    if (!result || 'skip' in result) throw new Error('expected forward')
    const body = JSON.parse(result.body)
    expect(body.events[0].params.email).not.toBe('alice@example.com')
    expect(body.events[0].params.email).toHaveLength(64)
  })

  it('reads params from a form-encoded body when the URL query is empty', async () => {
    const ctx = makeContext({
      originalUrl: 'https://www.google-analytics.com/g/collect',
      rawBody: 'v=2&tid=G-TEST&cid=body-cid&en=purchase&epn.value=99',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    })
    const result = await ga4Adapter.buildRequest(ctx)
    if (!result || 'skip' in result) throw new Error('expected forward')
    const body = JSON.parse(result.body)
    expect(body.client_id).toBe('body-cid')
    expect(body.events[0].name).toBe('purchase')
    expect(body.events[0].params.value).toBe(99)
  })
})

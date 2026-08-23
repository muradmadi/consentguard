import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { facebookAdapter } from './facebook'
import { facebook as facebookRule } from '../facebook'
import type { VendorContext } from './types'
import { getServerConfig } from '../../config'
import { createHasher } from '../../engine/transformations/hash'

const CREDENTIALS = {
  NODE_ENV: 'test',
  ADMIN_SECRET: 'x',
  META_PIXEL_ID: '123456789',
  META_ACCESS_TOKEN: 'test-token',
}

const PIXEL = 'https://www.facebook.com/tr/?id=123456789&ev=Purchase&dl=https%3A%2F%2Fshop.test%2Fc'

function makeContext(
  overrides: Partial<VendorContext> & { env?: Record<string, string> } = {},
): VendorContext {
  const env = overrides.env || CREDENTIALS
  return {
    method: 'GET',
    originalUrl: overrides.originalUrl ?? PIXEL,
    query: overrides.query ?? new URLSearchParams(),
    headers: overrides.headers ?? {},
    jsonBody: overrides.jsonBody ?? null,
    rawBody: overrides.rawBody ?? '',
    rule: overrides.rule ?? facebookRule,
    serverConfig: overrides.serverConfig ?? getServerConfig(env),
    hasher: overrides.hasher ?? createHasher('test-hash-secret'),
  }
}

function forward(ctx: VendorContext) {
  const result = facebookAdapter.buildRequest(ctx)
  if (!result || 'skip' in result || result instanceof Promise) {
    throw new Error('expected a forward')
  }
  return result
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe('Meta CAPI adapter', () => {
  it('skips when the pixel id or access token is missing', () => {
    const result = facebookAdapter.buildRequest(
      makeContext({ env: { NODE_ENV: 'test', ADMIN_SECRET: 'x' } }),
    )
    expect(result).toEqual({ skip: true, reason: expect.stringContaining('META_PIXEL_ID') })
  })

  it('skips a loader hit that names no event', () => {
    const result = facebookAdapter.buildRequest(
      makeContext({ originalUrl: 'https://connect.facebook.net/en_US/fbevents.js' }),
    )
    expect(result).toEqual({ skip: true, reason: expect.stringContaining('event name') })
  })

  it('translates a pixel beacon into the Conversions API envelope', () => {
    const built = forward(makeContext())

    expect(built.method).toBe('POST')
    expect(built.url).toBe('https://graph.facebook.com/v21.0/123456789/events')

    const body = JSON.parse(built.body)
    expect(body.data).toHaveLength(1)
    expect(body.data[0]).toMatchObject({
      event_name: 'Purchase',
      action_source: 'website',
      event_source_url: 'https://shop.test/c',
    })
    expect(body.access_token).toBe('test-token')
  })

  /**
   * The reason this adapter had to exist. The rule's match keys address the CAPI
   * body, so with the generic passthrough they never fired: the value scan
   * caught the address instead and pseudonymised it, and Meta received a keyed
   * digest it cannot match against anything.
   */
  it('sends em as the unsalted digest Meta can match, not a pseudonym', () => {
    const built = forward(
      makeContext({
        originalUrl: `${PIXEL}&ud%5Bem%5D=${encodeURIComponent('Alice@Example.com ')}`,
      }),
    )

    const body = JSON.parse(built.body)
    expect(body.data[0].user_data.em).toBe(sha256('alice@example.com'))
    expect(built.report).toContainEqual({
      path: 'data.*.user_data.em',
      action: 'hash',
      mode: 'match_key',
      matched: 1,
    })
  })

  it('normalises a phone the way Meta does before hashing it', () => {
    const built = forward(
      makeContext({
        originalUrl: `${PIXEL}&ud%5Bph%5D=${encodeURIComponent('+1 (555) 010-9999')}`,
      }),
    )
    expect(JSON.parse(built.body).data[0].user_data.ph).toBe(sha256('15550109999'))
  })

  /**
   * Advanced Matching hashes in the browser, so the value arriving is already
   * the digest. Hashing it again produces a digest of a digest — well-formed,
   * accepted, and matching nobody.
   */
  it('leaves a match key the pixel already hashed alone', () => {
    const digest = sha256('alice@example.com')
    const built = forward(makeContext({ originalUrl: `${PIXEL}&ud%5Bem%5D=${digest}` }))

    expect(JSON.parse(built.body).data[0].user_data.em).toBe(digest)
    // Nothing changed, so nothing is claimed: the audit is what fired.
    expect(built.report.some((r) => r.path === 'data.*.user_data.em')).toBe(false)
  })

  it('strips the address and user agent it collected, and proves it did', () => {
    const built = forward(
      makeContext({
        headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18', 'user-agent': 'Mozilla/5.0' },
      }),
    )

    const userData = JSON.parse(built.body).data[0].user_data
    expect(userData.client_ip_address).toBeUndefined()
    expect(userData.client_user_agent).toBeUndefined()
    expect(built.report).toContainEqual({
      path: 'data.*.user_data.client_ip_address',
      action: 'strip',
      matched: 1,
    })
    expect(built.report).toContainEqual({
      path: 'data.*.user_data.client_user_agent',
      action: 'strip',
      matched: 1,
    })
  })

  it('carries the pixel event id through so Meta can deduplicate', () => {
    const built = forward(makeContext({ originalUrl: `${PIXEL}&eid=evt-42` }))
    expect(JSON.parse(built.body).data[0].event_id).toBe('evt-42')
  })

  it('converts the pixel millisecond timestamp to CAPI seconds', () => {
    const built = forward(makeContext({ originalUrl: `${PIXEL}&ts=1755859200000` }))
    expect(JSON.parse(built.body).data[0].event_time).toBe(1755859200)
  })

  it('collects cd[] parameters as custom data', () => {
    const built = forward(
      makeContext({ originalUrl: `${PIXEL}&cd%5Bvalue%5D=42&cd%5B%5D=ignored` }),
    )
    expect(JSON.parse(built.body).data[0].custom_data).toEqual({ value: '42' })
  })

  it('keeps the access token out of the URL, which is what gets logged', () => {
    expect(forward(makeContext()).url).not.toContain('test-token')
  })
})

import { describe, it, expect } from 'vitest'
import { mixpanelAdapter } from './mixpanel'
import { mixpanel as mixpanelRule } from '../mixpanel'
import type { VendorContext } from './types'
import { getServerConfig } from '../../config'
import { createHasher } from '../../engine/transformations/hash'

const ENV = { NODE_ENV: 'test', ADMIN_SECRET: 'x' }

const BATCH = [
  {
    event: 'Signed Up',
    properties: {
      token: 'project-token',
      distinct_id: 'user-42',
      $email: 'alice@example.com',
      ip: '203.0.113.9',
      plan: 'pro',
    },
  },
]

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64')

function makeContext(overrides: Partial<VendorContext> = {}): VendorContext {
  return {
    method: 'POST',
    originalUrl: overrides.originalUrl ?? 'https://api-js.mixpanel.com/track/?verbose=1',
    query: overrides.query ?? new URLSearchParams(),
    headers: overrides.headers ?? { 'content-type': 'application/x-www-form-urlencoded' },
    jsonBody: overrides.jsonBody ?? null,
    rawBody: overrides.rawBody ?? `data=${encodeURIComponent(encode(BATCH))}`,
    rule: overrides.rule ?? mixpanelRule,
    serverConfig: overrides.serverConfig ?? getServerConfig(ENV),
    hasher: overrides.hasher ?? createHasher('test-hash-secret'),
  }
}

function forward(ctx: VendorContext) {
  const result = mixpanelAdapter.buildRequest(ctx)
  if (!result || 'skip' in result || result instanceof Promise) {
    throw new Error('expected a forward')
  }
  return result
}

describe('Mixpanel adapter', () => {
  /**
   * The whole reason this adapter exists. Before it, the base64 `data`
   * parameter was opaque to both scrub passes, so the batch was forwarded
   * verbatim and audited as `forwarded` with no transformations — an accurate
   * record of a leak.
   */
  it('decodes the base64 batch and scrubs what is inside it', () => {
    const built = forward(makeContext())
    const events = JSON.parse(built.body)

    expect(events[0].properties.$email).not.toBe('alice@example.com')
    expect(events[0].properties.$email).toHaveLength(64)
    expect(events[0].properties.ip).toBeUndefined()
    expect(built.report).toContainEqual({
      path: '*.properties.$email',
      action: 'hash',
      mode: 'pseudonymize',
      matched: 1,
    })
  })

  it('leaves the project token and the event payload intact', () => {
    const events = JSON.parse(forward(makeContext()).body)
    expect(events[0].properties.token).toBe('project-token')
    expect(events[0].event).toBe('Signed Up')
    expect(events[0].properties.plan).toBe('pro')
  })

  it('forwards to the server-side ingestion endpoint as JSON', () => {
    const built = forward(makeContext())
    expect(built.url).toBe('https://api.mixpanel.com/track?verbose=1')
    expect(built.method).toBe('POST')
    expect(built.headers['Content-Type']).toBe('application/json')
  })

  it('reads an unencoded batch when the SDK is configured for JSON payloads', () => {
    const built = forward(
      makeContext({
        headers: { 'content-type': 'application/json' },
        rawBody: JSON.stringify(BATCH),
      }),
    )
    expect(JSON.parse(built.body)[0].properties.ip).toBeUndefined()
  })

  it('reads the data parameter from the query string of a GET beacon', () => {
    const built = forward(
      makeContext({
        headers: {},
        rawBody: '',
        originalUrl: `https://api.mixpanel.com/track/?data=${encodeURIComponent(encode(BATCH))}`,
      }),
    )
    expect(JSON.parse(built.body)[0].properties.$email).toHaveLength(64)
  })

  it('normalises a single event into a batch so one rule addresses both', () => {
    const built = forward(makeContext({ rawBody: `data=${encodeURIComponent(encode(BATCH[0]))}` }))
    const events = JSON.parse(built.body)
    expect(Array.isArray(events)).toBe(true)
    expect(events[0].properties.$email).toHaveLength(64)
  })

  it('recovers a base64 payload whose + survived form decoding as a space', () => {
    // `data=` values that were not escaped arrive with + turned into spaces.
    const raw = encode(BATCH)
    const built = forward(makeContext({ rawBody: `data=${raw.replace(/\+/g, ' ')}` }))
    expect(JSON.parse(built.body)[0].event).toBe('Signed Up')
  })

  it('refuses an envelope it cannot decode rather than forwarding it', () => {
    const result = mixpanelAdapter.buildRequest(makeContext({ rawBody: 'data=not-base64-json' }))
    expect(result).toEqual({ skip: true, reason: expect.stringContaining('did not decode') })
  })

  it('refuses a beacon with no data parameter at all', () => {
    const result = mixpanelAdapter.buildRequest(
      makeContext({ headers: {}, rawBody: '', originalUrl: 'https://api-js.mixpanel.com/track/' }),
    )
    expect(result).toEqual({ skip: true, reason: expect.stringContaining('no data parameter') })
  })

  it('catches personal data at a path the rule never declared', () => {
    const built = forward(
      makeContext({
        rawBody: `data=${encodeURIComponent(
          encode([{ event: 'x', properties: { support_contact: 'bob@example.com' } }]),
        )}`,
      }),
    )
    expect(built.report.some((r) => r.detector === 'email')).toBe(true)
  })
})

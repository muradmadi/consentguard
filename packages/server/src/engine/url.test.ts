import { describe, it, expect } from 'vitest'
import type { DestinationRule } from '@sluice/shared'
import { scrubUrl } from './url'

const BARE: DestinationRule = {
  id: 'testvendor',
  category: 'analytics',
  endpoints: [],
  transformations: [],
}

const DECLARED: DestinationRule = {
  ...BARE,
  transformations: [
    { path: 'uid', action: 'hash' },
    { path: 'api_key', action: 'strip' },
  ],
}

describe('scrubUrl value scan', () => {
  it('hashes an email a rule never declared', () => {
    const result = scrubUrl('https://api.vendor.test/track?e=purchase&em=alice@example.com', BARE)
    const params = new URL(result.url).searchParams
    expect(params.get('e')).toBe('purchase')
    expect(params.get('em')).toMatch(/^[0-9a-f]{64}$/)
    expect(result.report).toEqual([{ path: '?em', action: 'hash', matched: 1, detector: 'email' }])
  })

  it('strips a raw IP address out of the query', () => {
    const result = scrubUrl('https://api.vendor.test/track?ip=203.0.113.9&e=view', BARE)
    const params = new URL(result.url).searchParams
    expect(params.has('ip')).toBe(false)
    expect(params.get('e')).toBe('view')
    expect(result.report).toEqual([{ path: '?ip', action: 'strip', matched: 1, detector: 'ipv4' }])
  })

  it('redacts personal data inside a longer parameter value', () => {
    const result = scrubUrl(
      'https://api.vendor.test/track?dl=' +
        encodeURIComponent('https://shop.test/thanks?buyer=bob@example.com'),
      BARE,
    )
    expect(new URL(result.url).searchParams.get('dl')).toBe(
      'https://shop.test/thanks?buyer=[REDACTED]',
    )
    expect(result.report).toEqual([
      { path: '?dl', action: 'redact', matched: 1, detector: 'email' },
    ])
  })

  it('keeps the origin and path untouched', () => {
    const result = scrubUrl('https://api.vendor.test/v2/collect?em=alice@example.com', BARE)
    const parsed = new URL(result.url)
    expect(parsed.origin).toBe('https://api.vendor.test')
    expect(parsed.pathname).toBe('/v2/collect')
  })

  it('scrubs every value of a repeated parameter', () => {
    const result = scrubUrl(
      'https://api.vendor.test/track?u=alice@example.com&u=plain&u=bob@example.com',
      BARE,
    )
    const values = new URL(result.url).searchParams.getAll('u')
    expect(values[0]).toMatch(/^[0-9a-f]{64}$/)
    expect(values[1]).toBe('plain')
    expect(values[2]).toMatch(/^[0-9a-f]{64}$/)
    expect(result.report).toEqual([
      { path: '?u.0', action: 'hash', matched: 1, detector: 'email' },
      { path: '?u.2', action: 'hash', matched: 1, detector: 'email' },
    ])
  })

  it('never records the value it removed', () => {
    const result = scrubUrl('https://api.vendor.test/track?em=alice@example.com', BARE)
    expect(JSON.stringify(result.report)).not.toContain('alice@example.com')
  })
})

describe('scrubUrl declared rules', () => {
  it('applies a declared transformation to a matching query parameter', () => {
    const result = scrubUrl('https://api.vendor.test/track?uid=user-1&api_key=secret', DECLARED)
    const params = new URL(result.url).searchParams
    expect(params.get('uid')).toMatch(/^[0-9a-f]{64}$/)
    expect(params.has('api_key')).toBe(false)
    expect(result.report).toEqual([
      { path: '?uid', action: 'hash', matched: 1 },
      { path: '?api_key', action: 'strip', matched: 1 },
    ])
  })

  it('reports declared and detected entries side by side', () => {
    const result = scrubUrl('https://api.vendor.test/track?uid=user-1&ip=203.0.113.9', DECLARED)
    expect(result.report).toEqual([
      { path: '?uid', action: 'hash', matched: 1 },
      { path: '?ip', action: 'strip', matched: 1, detector: 'ipv4' },
    ])
  })
})

describe('scrubUrl leaves alone what it must', () => {
  it('returns the url byte-identical when nothing fires', () => {
    const url = 'https://api.vendor.test/track?e=purchase&dl=a%20b&v=2'
    expect(scrubUrl(url, BARE)).toEqual({ url, report: [] })
  })

  it('returns a url with no query untouched', () => {
    const url = 'https://api.vendor.test/collect'
    expect(scrubUrl(url, BARE)).toEqual({ url, report: [] })
  })

  it('returns a url it cannot parse untouched', () => {
    const url = 'not-a-url?em=alice@example.com'
    expect(scrubUrl(url, BARE)).toEqual({ url, report: [] })
  })

  it('changes nothing when the scan is switched off and no rule declares a path', () => {
    const url = 'https://api.vendor.test/track?em=alice@example.com&ip=203.0.113.9'
    expect(scrubUrl(url, BARE, { detectors: [] })).toEqual({ url, report: [] })
  })
})

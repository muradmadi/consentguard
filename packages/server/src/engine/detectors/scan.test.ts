import { describe, it, expect } from 'vitest'
import { scanPayload } from './scan'
import { createHasher } from '../transformations/hash'
import { DEFAULT_DETECTORS, passesLuhn } from './patterns'

const ALL = [...DEFAULT_DETECTORS, 'us_ssn' as const]
const hasher = createHasher('test-hash-secret')

describe('passesLuhn', () => {
  it('accepts a valid card number', () => {
    expect(passesLuhn('4111111111111111')).toBe(true)
  })

  it('rejects the same number with one digit changed', () => {
    expect(passesLuhn('4111111111111112')).toBe(false)
  })
})

describe('scanPayload detectors', () => {
  it('hashes an email found under a key no rule declared', () => {
    const payload = { event: 'signup', custom_field_7: 'alice@example.com' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.custom_field_7).toMatch(/^[0-9a-f]{64}$/)
    expect(report).toEqual([
      {
        path: 'custom_field_7',
        action: 'hash',
        mode: 'pseudonymize',
        matched: 1,
        detector: 'email',
      },
    ])
  })

  it('strips a raw IPv4 address', () => {
    const payload: any = { ip: '192.168.1.44', event: 'page_view' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.ip).toBeUndefined()
    expect(payload.event).toBe('page_view')
    expect(report).toEqual([{ path: 'ip', action: 'strip', matched: 1, detector: 'ipv4' }])
  })

  it('strips a raw IPv6 address', () => {
    const payload: any = { addr: '2001:db8::8a2e:370:7334' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.addr).toBeUndefined()
    expect(report[0].detector).toBe('ipv6')
  })

  it('redacts personal data embedded in a longer string instead of destroying it', () => {
    // Hashing the whole URL would remove the page identity the vendor needs
    // without removing anything else.
    const payload = { dl: 'https://shop.test/checkout?email=alice@example.com&step=2' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.dl).toBe('https://shop.test/checkout?email=[REDACTED]&step=2')
    expect(report).toEqual([{ path: 'dl', action: 'redact', matched: 1, detector: 'email' }])
  })

  it('counts every occurrence at one path', () => {
    const payload = { note: 'cc alice@example.com and bob@example.com' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(report).toEqual([{ path: 'note', action: 'redact', matched: 2, detector: 'email' }])
    expect(payload.note).toBe('cc [REDACTED] and [REDACTED]')
  })

  it('reports the concrete path inside nested arrays', () => {
    const payload = { events: [{ params: { u: 'x' } }, { params: { u: 'bob@example.com' } }] }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(report).toEqual([
      {
        path: 'events.1.params.u',
        action: 'hash',
        mode: 'pseudonymize',
        matched: 1,
        detector: 'email',
      },
    ])
  })

  it('redacts rather than deletes inside an array, so indices do not shift', () => {
    const payload = { ips: ['10.0.0.1', 'keep'] }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.ips).toEqual(['[REDACTED]', 'keep'])
    expect(report).toEqual([{ path: 'ips.0', action: 'redact', matched: 1, detector: 'ipv4' }])
  })

  it('strips a Luhn-valid card number behind a known issuer prefix', () => {
    const payload: any = { field: '4111 1111 1111 1111' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.field).toBeUndefined()
    expect(report[0].detector).toBe('credit_card')
  })

  it('leaves a 16-digit id that fails Luhn alone', () => {
    const payload = { order_id: '4111111111111112' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.order_id).toBe('4111111111111112')
    expect(report).toEqual([])
  })

  it('hashes an E.164 phone number but leaves a bare digit run alone', () => {
    const payload = { phone: '+14155552671', order: '4155552671' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.phone).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.order).toBe('4155552671')
    expect(report).toEqual([
      { path: 'phone', action: 'hash', mode: 'pseudonymize', matched: 1, detector: 'phone' },
    ])
  })

  it('hashes a separated national phone number', () => {
    const payload = { contact: '(415) 555-2671' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(report).toEqual([
      { path: 'contact', action: 'hash', mode: 'pseudonymize', matched: 1, detector: 'phone' },
    ])
  })

  it('leaves an ISO timestamp and a semver string alone', () => {
    const payload = { ts: '2026-08-22T10:00:00.000Z', app_version: '2.14.9' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(report).toEqual([])
    expect(payload.ts).toBe('2026-08-22T10:00:00.000Z')
  })

  it('leaves a clock time alone despite the IPv6 detector', () => {
    const payload = { at: '12:34:56' }
    expect(scanPayload(payload, DEFAULT_DETECTORS, hasher)).toEqual([])
  })

  it('does not run us_ssn unless it is opted into', () => {
    const payload = { note: '123-45-6789' }
    expect(scanPayload(payload, DEFAULT_DETECTORS, hasher)).toEqual([])
    expect(payload.note).toBe('123-45-6789')

    const optedIn = { note: '123-45-6789' } as any
    const report = scanPayload(optedIn, ALL, hasher)
    expect(optedIn.note).toBeUndefined()
    expect(report[0].detector).toBe('us_ssn')
  })

  it('does nothing when every detector is disabled', () => {
    const payload = { email: 'alice@example.com' }
    expect(scanPayload(payload, [], hasher)).toEqual([])
    expect(payload.email).toBe('alice@example.com')
  })

  it('removes both an email and an IP from the same string', () => {
    const payload = { line: 'user alice@example.com from 203.0.113.9 hit /pricing' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(payload.line).toBe('user [REDACTED] from [REDACTED] hit /pricing')
    expect(report.map((r) => r.detector)).toEqual(['email', 'ipv4'])
  })

  it('never records the value it removed', () => {
    const payload = { anything: 'alice@example.com' }
    const report = scanPayload(payload, DEFAULT_DETECTORS, hasher)
    expect(JSON.stringify(report)).not.toContain('alice@example.com')
  })
})

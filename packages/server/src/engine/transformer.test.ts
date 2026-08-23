import { describe, it, expect } from 'vitest'
import { scrubPayload, type ScrubOptions } from './transformer'
import { createHasher } from './transformations/hash'
import { DestinationRule } from '@sluice/shared'

const hasher = createHasher('test-hash-secret')

function rule(transformations: DestinationRule['transformations']): DestinationRule {
  return { id: 'test', category: 'analytics', endpoints: [], transport: 'json', transformations }
}

function scrub(payload: any, r: DestinationRule, options: Omit<ScrubOptions, 'hasher'> = {}) {
  return scrubPayload(payload, r, { ...options, hasher })
}

describe('scrubPayload', () => {
  it('returns the payload untouched when there is nothing to do at all', () => {
    const payload = { event: 'page_view', user: { name: 'Alice' } }
    const result = scrub(payload, rule([]), { detectors: [] })
    expect(result.payload).toEqual(payload)
    expect(result.payload).toBe(payload)
    expect(result.report).toEqual([])
  })

  it('strips a flat property', () => {
    const payload = { event: 'page_view', secretField: 'secret-123', user: 'Alice' }
    const result = scrub(payload, rule([{ path: 'secretField', action: 'strip' }]))
    expect(result.payload.secretField).toBeUndefined()
    expect(result.payload.event).toBe('page_view')
    expect(result.payload.user).toBe('Alice')
  })

  it('strips a nested property', () => {
    const payload = { user: { name: 'Alice', email: 'alice@example.com' } }
    const result = scrub(payload, rule([{ path: 'user.email', action: 'strip' }]))
    expect(result.payload.user.email).toBeUndefined()
    expect(result.payload.user.name).toBe('Alice')
  })

  it('strips a property across a wildcard array path', () => {
    const payload = {
      users: [
        { name: 'Alice', email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ],
    }
    const result = scrub(payload, rule([{ path: 'users.*.email', action: 'strip' }]))
    expect(result.payload.users[0].email).toBeUndefined()
    expect(result.payload.users[0].name).toBe('Alice')
    expect(result.payload.users[1].email).toBeUndefined()
  })

  it('hashes a value to a SHA-256 hex string', () => {
    const payload = { email: 'Alice@Example.com ' }
    const result = scrub(payload, rule([{ path: 'email', action: 'hash' }]))
    expect(result.payload.email).not.toBe('Alice@Example.com ')
    expect(result.payload.email).toHaveLength(64)
  })

  it('redacts without a pattern by replacing the whole value', () => {
    const payload = { ssn: '123-456-7890', note: 'keep this' }
    const result = scrub(payload, rule([{ path: 'ssn', action: 'redact' }]))
    expect(result.payload.ssn).toBe('[REDACTED]')
    expect(result.payload.note).toBe('keep this')
  })

  it('redacts substrings matching a pattern', () => {
    const payload = { note: 'My phone is 555-1234.' }
    const result = scrub(
      payload,
      rule([{ path: 'note', action: 'redact', pattern: '\\d{3}-\\d{4}' }]),
    )
    expect(result.payload.note).toBe('My phone is [REDACTED].')
  })

  it('does not mutate the original payload', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrub(payload, rule([{ path: 'email', action: 'strip' }]))
    expect(payload.email).toBe('alice@example.com')
    expect(result.payload.email).toBeUndefined()
  })
})

describe('scrubPayload report', () => {
  it('records nothing for a declared path that is absent from the payload', () => {
    // The defect this whole contract exists to prevent: the audit used to be
    // built from the rule, so it claimed these fired against a payload
    // that never contained them.
    const payload = { event: 'page_view', plan: 'pro' }
    const result = scrub(
      payload,
      rule([
        { path: 'email', action: 'strip' },
        { path: 'phone', action: 'hash' },
      ]),
    )
    expect(result.report).toEqual([])
    expect(result.payload).toEqual({ event: 'page_view', plan: 'pro' })
  })

  it('records one entry per transformation that fired', () => {
    const payload = { email: 'alice@example.com', phone: '555-1234', plan: 'pro' }
    const result = scrub(
      payload,
      rule([
        { path: 'email', action: 'strip' },
        { path: 'phone', action: 'hash' },
      ]),
    )
    expect(result.report).toEqual([
      { path: 'email', action: 'strip', matched: 1 },
      { path: 'phone', action: 'hash', mode: 'pseudonymize', matched: 1 },
    ])
  })

  it('reports only the transformations that matched, not the whole rule', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrub(
      payload,
      rule([
        { path: 'email', action: 'strip' },
        { path: 'ip', action: 'strip' },
      ]),
    )
    expect(result.report).toEqual([{ path: 'email', action: 'strip', matched: 1 }])
  })

  it('counts every array element a wildcard path hit', () => {
    const payload = {
      users: [
        { email: 'alice@example.com' },
        { email: 'bob@example.com' },
        { name: 'no email here' },
      ],
    }
    const result = scrub(payload, rule([{ path: 'users.*.email', action: 'strip' }]))
    expect(result.report).toEqual([{ path: 'users.*.email', action: 'strip', matched: 2 }])
  })

  it('does not record a redaction whose pattern matched nothing', () => {
    const payload = { note: 'no digits at all' }
    const result = scrub(
      payload,
      rule([{ path: 'note', action: 'redact', pattern: '\\d{3}-\\d{4}' }]),
    )
    expect(result.report).toEqual([])
    expect(result.payload.note).toBe('no digits at all')
  })

  it('does not record a hash against a non-string value', () => {
    const payload = { user_id: 12345 }
    const result = scrub(payload, rule([{ path: 'user_id', action: 'hash' }]))
    expect(result.report).toEqual([])
    expect(result.payload.user_id).toBe(12345)
  })

  it('never records the value it removed', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrub(payload, rule([{ path: 'email', action: 'strip' }]))
    expect(JSON.stringify(result.report)).not.toContain('alice@example.com')
  })
})

describe('scrubPayload value scan', () => {
  it('scrubs personal data no rule declared', () => {
    const payload = { event: 'signup', extra: { note: 'reach me at alice@example.com' } }
    const result = scrub(payload, rule([]))
    expect(result.payload.extra.note).toBe('reach me at [REDACTED]')
    expect(result.report).toEqual([
      { path: 'extra.note', action: 'redact', matched: 1, detector: 'email' },
    ])
  })

  it('runs the declared pass first, so an already-hashed field is not re-detected', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrub(payload, rule([{ path: 'email', action: 'hash' }]))
    expect(result.report).toEqual([
      { path: 'email', action: 'hash', mode: 'pseudonymize', matched: 1 },
    ])
    expect(result.payload.email).toMatch(/^[0-9a-f]{64}$/)
  })

  it('reports declared and detected entries side by side', () => {
    const payload = { email: 'alice@example.com', ua_extra: '203.0.113.9' }
    const result = scrub(payload, rule([{ path: 'email', action: 'strip' }]))
    expect(result.report).toEqual([
      { path: 'email', action: 'strip', matched: 1 },
      { path: 'ua_extra', action: 'strip', matched: 1, detector: 'ipv4' },
    ])
  })

  it('does not mutate the original payload when only the scan fires', () => {
    const payload = { anything: 'alice@example.com' }
    const result = scrub(payload, rule([]))
    expect(payload.anything).toBe('alice@example.com')
    expect(result.payload.anything).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves the payload alone when the scan is switched off', () => {
    const payload = { anything: 'alice@example.com' }
    const result = scrub(payload, rule([]), { detectors: [] })
    expect(result.payload.anything).toBe('alice@example.com')
    expect(result.report).toEqual([])
  })
})

/**
 * The weaker digest is the one a rule has to ask for by name. A field nobody
 * declared as a vendor match key gets a pseudonym, and the report says which.
 */
describe('scrubPayload hash modes', () => {
  it('pseudonymizes a declared hash that names no mode', () => {
    const payload = { user_id: 'alice@example.com' }
    const result = scrub(payload, rule([{ path: 'user_id', action: 'hash' }]), { detectors: [] })
    expect(result.payload.user_id).toBe(hasher.pseudonymize('alice@example.com'))
    expect(result.report).toEqual([
      { path: 'user_id', action: 'hash', mode: 'pseudonymize', matched: 1 },
    ])
  })

  it('still pseudonymizes when a rule names a format but not the mode', () => {
    const payload = { em: 'alice@example.com' }
    const result = scrub(payload, rule([{ path: 'em', action: 'hash', normalize: 'email' }]), {
      detectors: [],
    })
    expect(result.payload.em).toBe(hasher.pseudonymize('alice@example.com'))
    expect(result.payload.em).not.toBe(hasher.matchKey('alice@example.com', 'email'))
    expect(result.report).toEqual([
      { path: 'em', action: 'hash', mode: 'pseudonymize', matched: 1 },
    ])
  })

  it('produces the vendor match key only where the rule declares one', () => {
    const payload = { em: 'Alice@Example.com', other: 'alice@example.com' }
    const result = scrub(
      payload,
      rule([
        { path: 'em', action: 'hash', mode: 'match_key', normalize: 'email' },
        { path: 'other', action: 'hash' },
      ]),
      { detectors: [] },
    )
    expect(result.payload.em).toBe(hasher.matchKey('alice@example.com', 'email'))
    expect(result.payload.other).toBe(hasher.pseudonymize('alice@example.com'))
    expect(result.payload.em).not.toBe(result.payload.other)
    expect(result.report).toEqual([
      { path: 'em', action: 'hash', mode: 'match_key', matched: 1 },
      { path: 'other', action: 'hash', mode: 'pseudonymize', matched: 1 },
    ])
  })

  it('removes a match key it cannot normalise, and says so', () => {
    const payload = { ph: 'ask reception' }
    const result = scrub(
      payload,
      rule([{ path: 'ph', action: 'hash', mode: 'match_key', normalize: 'phone' }]),
      { detectors: [] },
    )
    expect(result.payload.ph).toBeUndefined()
    expect(result.report).toEqual([{ path: 'ph', action: 'strip', matched: 1 }])
  })

  it('splits one wildcard path into a group per outcome actually produced', () => {
    const payload = {
      data: [{ user_data: { ph: '+1 650 555 5555' } }, { user_data: { ph: 'ask reception' } }],
    }
    const result = scrub(
      payload,
      rule([
        { path: 'data.*.user_data.ph', action: 'hash', mode: 'match_key', normalize: 'phone' },
      ]),
      { detectors: [] },
    )
    expect(result.payload.data[0].user_data.ph).toMatch(/^[0-9a-f]{64}$/)
    expect(result.payload.data[1].user_data.ph).toBeUndefined()
    expect(result.report).toEqual([
      { path: 'data.*.user_data.ph', action: 'hash', mode: 'match_key', matched: 1 },
      { path: 'data.*.user_data.ph', action: 'strip', matched: 1 },
    ])
  })

  it('pseudonymizes what the value scan finds, whatever the rule declares elsewhere', () => {
    const payload = { em: 'alice@example.com', custom_field_7: 'bob@example.com' }
    const result = scrub(
      payload,
      rule([{ path: 'em', action: 'hash', mode: 'match_key', normalize: 'email' }]),
    )
    expect(result.payload.custom_field_7).toBe(hasher.pseudonymize('bob@example.com'))
    expect(result.report).toEqual([
      { path: 'em', action: 'hash', mode: 'match_key', matched: 1 },
      {
        path: 'custom_field_7',
        action: 'hash',
        mode: 'pseudonymize',
        matched: 1,
        detector: 'email',
      },
    ])
  })
})

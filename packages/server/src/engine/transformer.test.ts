import { describe, it, expect } from 'vitest'
import { scrubPayload } from './transformer'
import { DestinationRule } from '@sluice/shared'

function rule(transformations: DestinationRule['transformations']): DestinationRule {
  return { id: 'test', category: 'analytics', endpoints: [], transformations }
}

describe('scrubPayload', () => {
  it('returns the payload unchanged when no transformations are defined', () => {
    const payload = { event: 'page_view', user: { name: 'Alice' } }
    const result = scrubPayload(payload, rule([]))
    expect(result.payload).toEqual(payload)
    expect(result.payload).toBe(payload)
    expect(result.report).toEqual([])
  })

  it('strips a flat property', () => {
    const payload = { event: 'page_view', secretField: 'secret-123', user: 'Alice' }
    const result = scrubPayload(payload, rule([{ path: 'secretField', action: 'strip' }]))
    expect(result.payload.secretField).toBeUndefined()
    expect(result.payload.event).toBe('page_view')
    expect(result.payload.user).toBe('Alice')
  })

  it('strips a nested property', () => {
    const payload = { user: { name: 'Alice', email: 'alice@example.com' } }
    const result = scrubPayload(payload, rule([{ path: 'user.email', action: 'strip' }]))
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
    const result = scrubPayload(payload, rule([{ path: 'users.*.email', action: 'strip' }]))
    expect(result.payload.users[0].email).toBeUndefined()
    expect(result.payload.users[0].name).toBe('Alice')
    expect(result.payload.users[1].email).toBeUndefined()
  })

  it('hashes a value to a SHA-256 hex string', () => {
    const payload = { email: 'Alice@Example.com ' }
    const result = scrubPayload(payload, rule([{ path: 'email', action: 'hash' }]))
    expect(result.payload.email).not.toBe('Alice@Example.com ')
    expect(result.payload.email).toHaveLength(64)
  })

  it('redacts without a pattern by replacing the whole value', () => {
    const payload = { ssn: '123-456-7890', note: 'keep this' }
    const result = scrubPayload(payload, rule([{ path: 'ssn', action: 'redact' }]))
    expect(result.payload.ssn).toBe('[REDACTED]')
    expect(result.payload.note).toBe('keep this')
  })

  it('redacts substrings matching a pattern', () => {
    const payload = { note: 'My phone is 555-1234.' }
    const result = scrubPayload(
      payload,
      rule([{ path: 'note', action: 'redact', pattern: '\\d{3}-\\d{4}' }]),
    )
    expect(result.payload.note).toBe('My phone is [REDACTED].')
  })

  it('does not mutate the original payload', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrubPayload(payload, rule([{ path: 'email', action: 'strip' }]))
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
    const result = scrubPayload(
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
    const result = scrubPayload(
      payload,
      rule([
        { path: 'email', action: 'strip' },
        { path: 'phone', action: 'hash' },
      ]),
    )
    expect(result.report).toEqual([
      { path: 'email', action: 'strip', matched: 1 },
      { path: 'phone', action: 'hash', matched: 1 },
    ])
  })

  it('reports only the transformations that matched, not the whole rule', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrubPayload(
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
    const result = scrubPayload(payload, rule([{ path: 'users.*.email', action: 'strip' }]))
    expect(result.report).toEqual([{ path: 'users.*.email', action: 'strip', matched: 2 }])
  })

  it('does not record a redaction whose pattern matched nothing', () => {
    const payload = { note: 'no digits at all' }
    const result = scrubPayload(
      payload,
      rule([{ path: 'note', action: 'redact', pattern: '\\d{3}-\\d{4}' }]),
    )
    expect(result.report).toEqual([])
    expect(result.payload.note).toBe('no digits at all')
  })

  it('does not record a hash against a non-string value', () => {
    const payload = { user_id: 12345 }
    const result = scrubPayload(payload, rule([{ path: 'user_id', action: 'hash' }]))
    expect(result.report).toEqual([])
    expect(result.payload.user_id).toBe(12345)
  })

  it('never records the value it removed', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrubPayload(payload, rule([{ path: 'email', action: 'strip' }]))
    expect(JSON.stringify(result.report)).not.toContain('alice@example.com')
  })
})

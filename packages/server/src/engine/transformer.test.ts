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
    expect(result).toEqual(payload)
    expect(result).toBe(payload)
  })

  it('strips a flat property', () => {
    const payload = { event: 'page_view', secretField: 'secret-123', user: 'Alice' }
    const result = scrubPayload(payload, rule([{ path: 'secretField', action: 'strip' }]))
    expect(result.secretField).toBeUndefined()
    expect(result.event).toBe('page_view')
    expect(result.user).toBe('Alice')
  })

  it('strips a nested property', () => {
    const payload = { user: { name: 'Alice', email: 'alice@example.com' } }
    const result = scrubPayload(payload, rule([{ path: 'user.email', action: 'strip' }]))
    expect(result.user.email).toBeUndefined()
    expect(result.user.name).toBe('Alice')
  })

  it('strips a property across a wildcard array path', () => {
    const payload = {
      users: [
        { name: 'Alice', email: 'alice@example.com' },
        { name: 'Bob', email: 'bob@example.com' },
      ],
    }
    const result = scrubPayload(payload, rule([{ path: 'users.*.email', action: 'strip' }]))
    expect(result.users[0].email).toBeUndefined()
    expect(result.users[0].name).toBe('Alice')
    expect(result.users[1].email).toBeUndefined()
  })

  it('hashes a value to a SHA-256 hex string', () => {
    const payload = { email: 'Alice@Example.com ' }
    const result = scrubPayload(payload, rule([{ path: 'email', action: 'hash' }]))
    expect(result.email).not.toBe('Alice@Example.com ')
    expect(result.email).toHaveLength(64)
  })

  it('redacts without a pattern by replacing the whole value', () => {
    const payload = { ssn: '123-456-7890', note: 'keep this' }
    const result = scrubPayload(payload, rule([{ path: 'ssn', action: 'redact' }]))
    expect(result.ssn).toBe('[REDACTED]')
    expect(result.note).toBe('keep this')
  })

  it('redacts substrings matching a pattern', () => {
    const payload = { note: 'My phone is 555-1234.' }
    const result = scrubPayload(
      payload,
      rule([{ path: 'note', action: 'redact', pattern: '\\d{3}-\\d{4}' }]),
    )
    expect(result.note).toBe('My phone is [REDACTED].')
  })

  it('does not mutate the original payload', () => {
    const payload = { email: 'alice@example.com' }
    const result = scrubPayload(payload, rule([{ path: 'email', action: 'strip' }]))
    expect(payload.email).toBe('alice@example.com')
    expect(result.email).toBeUndefined()
  })
})

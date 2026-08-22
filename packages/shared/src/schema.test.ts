import { describe, it, expect } from 'vitest'
import {
  ConsentStateSchema,
  DestinationRuleSchema,
  IngestRequestSchema,
  TransformationActionSchema,
} from './schema'

describe('ConsentStateSchema', () => {
  const valid = {
    userId: 'u_123',
    purposes: { analytics: true, marketing: false },
    timestamp: 1_700_000_000_000,
  }

  it('accepts a well-formed consent record', () => {
    const parsed = ConsentStateSchema.parse(valid)
    expect(parsed.purposes.analytics).toBe(true)
    expect(parsed.metadata).toBeUndefined()
  })

  it('accepts optional metadata of mixed shape', () => {
    const parsed = ConsentStateSchema.parse({
      ...valid,
      metadata: { source: 'client', region: 'eu', attempts: 2 },
    })
    expect(parsed.metadata).toEqual({ source: 'client', region: 'eu', attempts: 2 })
  })

  it('rejects non-boolean purpose values', () => {
    const result = ConsentStateSchema.safeParse({ ...valid, purposes: { analytics: 'yes' } })
    expect(result.success).toBe(false)
  })

  it('rejects a fractional timestamp', () => {
    const result = ConsentStateSchema.safeParse({ ...valid, timestamp: 1.5 })
    expect(result.success).toBe(false)
  })

  it('rejects a missing userId', () => {
    const { userId: _userId, ...withoutUser } = valid
    expect(ConsentStateSchema.safeParse(withoutUser).success).toBe(false)
  })
})

describe('TransformationActionSchema', () => {
  it.each(['strip', 'hash', 'redact'])('accepts %s', (action) => {
    expect(TransformationActionSchema.parse(action)).toBe(action)
  })

  it('rejects an unknown action', () => {
    expect(TransformationActionSchema.safeParse('encrypt').success).toBe(false)
  })
})

describe('DestinationRuleSchema', () => {
  const minimal = { id: 'ga4', category: 'analytics', endpoints: ['google-analytics.com'] }

  it('defaults transformations to an empty list', () => {
    const parsed = DestinationRuleSchema.parse(minimal)
    expect(parsed.transformations).toEqual([])
  })

  it('parses transformations with an optional redaction pattern', () => {
    const parsed = DestinationRuleSchema.parse({
      ...minimal,
      upstreamUrl: 'https://www.google-analytics.com/mp/collect',
      transformations: [
        { path: 'events.*.params.email', action: 'hash' },
        { path: 'user.note', action: 'redact', pattern: '\\d{3}-\\d{4}' },
      ],
    })
    expect(parsed.transformations).toHaveLength(2)
    expect(parsed.transformations[1].pattern).toBe('\\d{3}-\\d{4}')
  })

  it('rejects an unknown transformation action', () => {
    const result = DestinationRuleSchema.safeParse({
      ...minimal,
      transformations: [{ path: 'a.b', action: 'obfuscate' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects endpoints that are not strings', () => {
    expect(DestinationRuleSchema.safeParse({ ...minimal, endpoints: [42] }).success).toBe(false)
  })
})

describe('IngestRequestSchema', () => {
  it('accepts an arbitrary payload alongside a destination', () => {
    const parsed = IngestRequestSchema.parse({
      destination: 'ga4',
      payload: { events: [{ name: 'page_view' }] },
    })
    expect(parsed.destination).toBe('ga4')
  })

  it('rejects a missing destination', () => {
    expect(IngestRequestSchema.safeParse({ payload: {} }).success).toBe(false)
  })
})

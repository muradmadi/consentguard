import { describe, it, expect } from 'vitest'
import {
  AuditRecordSchema,
  PiiDetectorSchema,
  ConsentStateSchema,
  DestinationRuleSchema,
  IngestRequestSchema,
  TransformationActionSchema,
  TransformationRecordSchema,
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

describe('TransformationRecordSchema', () => {
  it('accepts a record of one firing transformation', () => {
    const parsed = TransformationRecordSchema.parse({
      path: 'events.*.params.email',
      action: 'hash',
      matched: 2,
    })
    expect(parsed.matched).toBe(2)
  })

  it('rejects a matched count of zero', () => {
    // A transformation that changed nothing is not evidence and is never stored.
    const result = TransformationRecordSchema.safeParse({
      path: 'email',
      action: 'strip',
      matched: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects an unknown action', () => {
    const result = TransformationRecordSchema.safeParse({
      path: 'email',
      action: 'encrypt',
      matched: 1,
    })
    expect(result.success).toBe(false)
  })
})

describe('PiiDetectorSchema', () => {
  it.each(['email', 'phone', 'ipv4', 'ipv6', 'credit_card', 'us_ssn'])('accepts %s', (id) => {
    expect(PiiDetectorSchema.parse(id)).toBe(id)
  })

  it('rejects an unknown detector', () => {
    expect(PiiDetectorSchema.safeParse('passport').success).toBe(false)
  })
})

describe('AuditRecordSchema', () => {
  const minimal = {
    timestamp: '2026-08-22T10:00:00.000Z',
    userId: 'u_123',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent_granted',
  }

  it('defaults transformations to an empty list', () => {
    const parsed = AuditRecordSchema.parse(minimal)
    expect(parsed.transformations).toEqual([])
  })

  it.each(['forwarded', 'blocked', 'buffered', 'failed'])('accepts decision %s', (decision) => {
    expect(AuditRecordSchema.parse({ ...minimal, decision }).decision).toBe(decision)
  })

  it('rejects the retired scrubbed decision', () => {
    // Scrubbing is no longer a decision; it is transformations.length > 0.
    expect(AuditRecordSchema.safeParse({ ...minimal, decision: 'scrubbed' }).success).toBe(false)
  })

  it('rejects the retired stringly-typed transformationsApplied shape', () => {
    const result = AuditRecordSchema.safeParse({
      ...minimal,
      transformations: ['strip:email', 'hash:phone'],
    })
    expect(result.success).toBe(false)
  })

  it('carries the detector that found the data when the scan produced the entry', () => {
    const parsed = AuditRecordSchema.parse({
      ...minimal,
      transformations: [{ path: 'ep.note', action: 'redact', matched: 2, detector: 'email' }],
    })
    expect(parsed.transformations[0].detector).toBe('email')
  })

  it('leaves detector unset for an entry a declared rule path produced', () => {
    const parsed = AuditRecordSchema.parse({
      ...minimal,
      transformations: [{ path: 'user.email', action: 'hash', matched: 1 }],
    })
    expect(parsed.transformations[0].detector).toBeUndefined()
  })

  it('parses a record carrying real transformation evidence', () => {
    const parsed = AuditRecordSchema.parse({
      ...minimal,
      purposesRequired: 'analytics',
      purposesGranted: ['analytics'],
      transformations: [{ path: 'email', action: 'strip', matched: 1 }],
    })
    expect(parsed.transformations[0].path).toBe('email')
  })
})

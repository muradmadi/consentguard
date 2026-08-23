import { describe, it, expect } from 'vitest'
import {
  AuditRecordSchema,
  PiiDetectorSchema,
  ConsentStateSchema,
  DestinationRuleSchema,
  IngestRequestSchema,
  TransformationActionSchema,
  TransformationRecordSchema,
  UNKNOWN_DESTINATION_CATEGORY,
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
  const minimal = {
    id: 'ga4',
    category: 'analytics',
    endpoints: ['google-analytics.com'],
    transport: 'pixel',
  }

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

  /**
   * `transport` is required rather than defaulted, and a rule override that
   * will not parse is discarded in favour of the registry. That makes a
   * pre-transport override fall back to the reviewed rule, where a default
   * would have quietly answered the question on its behalf — and the question
   * is whether the payload can be scrubbed at all.
   */
  it('rejects a rule that does not say how the vendor carries its payload', () => {
    const { transport: _transport, ...withoutTransport } = minimal
    expect(DestinationRuleSchema.safeParse(withoutTransport).success).toBe(false)
  })

  it.each(['pixel', 'json', 'opaque'])('accepts transport %s', (transport) => {
    expect(DestinationRuleSchema.parse({ ...minimal, transport }).transport).toBe(transport)
  })

  it('rejects a transport nobody has taught the scrub passes to read', () => {
    expect(DestinationRuleSchema.safeParse({ ...minimal, transport: 'grpc' }).success).toBe(false)
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

  it.each(['forwarded', 'blocked', 'failed'])('accepts decision %s', (decision) => {
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

/**
 * A match key is the weaker disclosure — a digest the vendor, and anyone else
 * holding the address, can compute. The schema is where "only where a rule says
 * so, and only where it says which format" is enforced, because a rule override
 * that fails to parse is discarded in favour of the registry.
 */
describe('hash modes on a destination rule', () => {
  const base = {
    id: 'meta',
    category: 'marketing',
    endpoints: ['facebook.com/tr'],
    transport: 'pixel',
  }

  it('defaults to no mode, which the transformer reads as pseudonymize', () => {
    const parsed = DestinationRuleSchema.parse({
      ...base,
      transformations: [{ path: 'user_id', action: 'hash' }],
    })
    expect(parsed.transformations[0].mode).toBeUndefined()
  })

  it('accepts a match key that says which format it holds', () => {
    const parsed = DestinationRuleSchema.parse({
      ...base,
      transformations: [{ path: 'em', action: 'hash', mode: 'match_key', normalize: 'email' }],
    })
    expect(parsed.transformations[0]).toMatchObject({ mode: 'match_key', normalize: 'email' })
  })

  it('rejects a match key with no normalisation, which would match nothing', () => {
    const result = DestinationRuleSchema.safeParse({
      ...base,
      transformations: [{ path: 'em', action: 'hash', mode: 'match_key' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a mode on an action that does not hash', () => {
    const result = DestinationRuleSchema.safeParse({
      ...base,
      transformations: [{ path: 'em', action: 'strip', mode: 'match_key', normalize: 'email' }],
    })
    expect(result.success).toBe(false)
  })

  it('rejects a mode nobody defined', () => {
    const result = DestinationRuleSchema.safeParse({
      ...base,
      transformations: [{ path: 'em', action: 'hash', mode: 'plain_sha256' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('TransformationRecordSchema hash mode', () => {
  it('records which hash was applied', () => {
    const parsed = TransformationRecordSchema.parse({
      path: 'em',
      action: 'hash',
      matched: 1,
      mode: 'match_key',
    })
    expect(parsed.mode).toBe('match_key')
  })

  it('leaves the mode unset on a record written before the modes existed', () => {
    const parsed = TransformationRecordSchema.parse({ path: 'em', action: 'hash', matched: 1 })
    expect(parsed.mode).toBeUndefined()
  })
})

describe('UNKNOWN_DESTINATION_CATEGORY', () => {
  it('is not a purpose any consent management platform grants', () => {
    expect(UNKNOWN_DESTINATION_CATEGORY).toBe('unknown')
    expect(UNKNOWN_DESTINATION_CATEGORY).not.toBe('necessary')
  })
})

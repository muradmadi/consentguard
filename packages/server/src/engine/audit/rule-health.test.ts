import { describe, it, expect } from 'vitest'
import type {
  AuditPage,
  DestinationRule,
  SealedAuditRecord,
  TransformationRecord,
} from '@sluice/shared'
import { sealRecord } from './chain'
import { afterCursor, matchesQuery, pageSize } from './query'
import type { AuditQuery } from './sink/types'
import { deriveRuleHealth } from './rule-health'

const rule: DestinationRule = {
  id: 'mixpanel',
  category: 'analytics',
  endpoints: ['api.mixpanel.com'],
  transport: 'json',
  transformations: [
    { path: 'properties.$email', action: 'hash' },
    { path: 'properties.ip', action: 'strip' },
  ],
}

/** A queryable stand-in for the sink, paging newest-first like the real one. */
function source(records: SealedAuditRecord[]) {
  const newestFirst = [...records].reverse()
  return {
    async query(query: AuditQuery): Promise<AuditPage> {
      const limit = pageSize(query.limit)
      const matched = newestFirst.filter(
        (r) => afterCursor(r, query.cursor) && matchesQuery(r, query),
      )
      const page = matched.slice(0, limit)
      return {
        records: page,
        nextCursor: matched.length > limit ? page[page.length - 1].seq : null,
        scanned: matched.length,
      }
    },
  }
}

function chainOf(
  entries: Array<{
    destination?: string
    timestamp: string
    transformations: TransformationRecord[]
  }>,
): SealedAuditRecord[] {
  const sealed: SealedAuditRecord[] = []
  for (const item of entries) {
    const previous = sealed[sealed.length - 1]
    sealed.push(
      sealRecord(
        {
          timestamp: item.timestamp,
          userId: 'user-1',
          destination: item.destination ?? 'mixpanel',
          decision: 'forwarded',
          reason: 'consent_granted',
          transformations: item.transformations,
        },
        previous ? { seq: previous.seq, hash: previous.hash } : null,
      ),
    )
  }
  return sealed
}

describe('deriveRuleHealth', () => {
  it('counts a declared path that fired and dates its last firing', async () => {
    const records = chainOf([
      {
        timestamp: '2026-08-20T10:00:00.000Z',
        transformations: [{ path: 'properties.ip', action: 'strip', matched: 1 }],
      },
      {
        timestamp: '2026-08-22T10:00:00.000Z',
        transformations: [{ path: 'properties.ip', action: 'strip', matched: 2 }],
      },
    ])

    const report = await deriveRuleHealth(source(records), [rule])
    const ip = report.destinations[0].declared.find((d) => d.path === 'properties.ip')

    expect(ip).toMatchObject({ matched: 3, lastFiredAt: '2026-08-22T10:00:00.000Z' })
  })

  it('reports a declared path that has never fired as a dead rule', async () => {
    const records = chainOf([
      {
        timestamp: '2026-08-22T10:00:00.000Z',
        transformations: [{ path: 'properties.ip', action: 'strip', matched: 1 }],
      },
    ])

    const report = await deriveRuleHealth(source(records), [rule])
    const email = report.destinations[0].declared.find((d) => d.path === 'properties.$email')

    expect(email).toMatchObject({ matched: 0, lastFiredAt: null })
  })

  it('credits the declared rule when the path fired in the query string', async () => {
    const records = chainOf([
      {
        timestamp: '2026-08-22T10:00:00.000Z',
        transformations: [{ path: '?properties.ip', action: 'strip', matched: 1 }],
      },
    ])

    const report = await deriveRuleHealth(source(records), [rule])
    const ip = report.destinations[0].declared.find((d) => d.path === 'properties.ip')

    expect(ip?.matched).toBe(1)
  })

  it('keeps what the value scan caught out of the declared tally', async () => {
    const records = chainOf([
      {
        timestamp: '2026-08-22T10:00:00.000Z',
        transformations: [
          { path: 'properties.ip', action: 'strip', matched: 1, detector: 'ipv4' },
          { path: 'properties.contact', action: 'hash', matched: 2, detector: 'email' },
        ],
      },
    ])

    const report = await deriveRuleHealth(source(records), [rule])
    const health = report.destinations[0]

    expect(health.declared.find((d) => d.path === 'properties.ip')?.matched).toBe(0)
    expect(health.detected).toEqual([
      { detector: 'email', matched: 2 },
      { detector: 'ipv4', matched: 1 },
    ])
  })

  it('does not credit one destination for what another one scrubbed', async () => {
    const records = chainOf([
      {
        destination: 'ga4',
        timestamp: '2026-08-22T10:00:00.000Z',
        transformations: [{ path: 'properties.ip', action: 'strip', matched: 1 }],
      },
    ])

    const report = await deriveRuleHealth(source(records), [rule])
    expect(report.destinations[0].declared.every((d) => d.matched === 0)).toBe(true)
  })

  it('says when it stopped counting, so the numbers are not read as totals', async () => {
    const records = chainOf(
      Array.from({ length: 5 }, (_, i) => ({
        timestamp: `2026-08-22T10:00:0${i}.000Z`,
        transformations: [{ path: 'properties.ip', action: 'strip' as const, matched: 1 }],
      })),
    )

    const capped = await deriveRuleHealth(source(records), [rule], { scanLimit: 2 })
    expect(capped).toMatchObject({ recordsScanned: 2, scanLimit: 2, truncated: true })
    expect(capped.destinations[0].declared.find((d) => d.path === 'properties.ip')?.matched).toBe(2)

    const complete = await deriveRuleHealth(source(records), [rule], { scanLimit: 100 })
    expect(complete).toMatchObject({ recordsScanned: 5, truncated: false })
  })
})

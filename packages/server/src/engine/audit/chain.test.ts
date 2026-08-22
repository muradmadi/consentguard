import { describe, it, expect } from 'vitest'
import type { AuditRecord, SealedAuditRecord } from '@sluice/shared'
import { canonicalJson, GENESIS_HASH, hashRecord, sealRecord, verifyChain } from './chain'

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    timestamp: '2026-08-22T10:00:00.000Z',
    userId: 'user-1',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent_granted',
    transformations: [],
    ...overrides,
  }
}

/** A run of sealed records, each linked to the one before it. */
function chainOf(count: number): SealedAuditRecord[] {
  const sealed: SealedAuditRecord[] = []
  for (let i = 0; i < count; i++) {
    const previous = sealed[sealed.length - 1]
    sealed.push(
      sealRecord(
        record({ userId: `user-${i}`, timestamp: `2026-08-22T10:00:0${i}.000Z` }),
        previous ? { seq: previous.seq, hash: previous.hash } : null,
      ),
    )
  }
  return sealed
}

describe('canonicalJson', () => {
  it('serialises the same object identically whatever order its keys arrive in', () => {
    const a = { destination: 'ga4', userId: 'u', nested: { b: 2, a: 1 } }
    const b = { nested: { a: 1, b: 2 }, userId: 'u', destination: 'ga4' }
    expect(canonicalJson(a)).toBe(canonicalJson(b))
  })

  it('keeps array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
  })
})

describe('sealRecord', () => {
  it('starts the chain at genesis', () => {
    const sealed = sealRecord(record(), null)
    expect(sealed.seq).toBe(0)
    expect(sealed.prevHash).toBe(GENESIS_HASH)
    expect(sealed.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('links each record to the digest of the one before it', () => {
    const [first, second] = chainOf(2)
    expect(second.seq).toBe(1)
    expect(second.prevHash).toBe(first.hash)
  })

  it('hashes the record without its own digest, so a re-parse verifies', () => {
    const sealed = sealRecord(record(), null)
    const roundTripped = JSON.parse(JSON.stringify(sealed))
    const { hash, ...unsealed } = roundTripped
    expect(hashRecord(unsealed)).toBe(hash)
  })
})

describe('verifyChain', () => {
  it('accepts a chain that has not been touched', async () => {
    const result = await verifyChain(chainOf(5))
    expect(result.status).toBe('intact')
    expect(result.checked).toBe(5)
    expect(result.head?.seq).toBe(4)
  })

  it('accepts an empty sink', async () => {
    expect(await verifyChain([])).toMatchObject({ status: 'intact', checked: 0, head: null })
  })

  it('catches a record edited after it was written', async () => {
    const records = chainOf(4)
    records[2] = { ...records[2], decision: 'blocked' }

    const result = await verifyChain(records)
    expect(result.status).toBe('broken')
    expect(result.brokenAt).toBe(2)
    expect(result.reason).toMatch(/altered/)
  })

  it('catches a record deleted from the middle', async () => {
    const records = chainOf(4)
    records.splice(2, 1)

    const result = await verifyChain(records)
    expect(result.status).toBe('broken')
    expect(result.brokenAt).toBe(3)
  })

  it('catches two records swapped', async () => {
    const records = chainOf(4)
    ;[records[1], records[2]] = [records[2], records[1]]

    const result = await verifyChain(records)
    expect(result.status).toBe('broken')
  })

  it('reads a legitimately expired prefix as truncated, not broken', async () => {
    const records = chainOf(5)
    const retained = records.slice(2)
    const anchor = { seq: records[1].seq, hash: records[1].hash }

    expect(await verifyChain(retained, anchor)).toMatchObject({ status: 'intact', checked: 3 })

    const withoutAnchor = await verifyChain(retained)
    expect(withoutAnchor.status).toBe('truncated')
    expect(withoutAnchor.checked).toBe(3)
    expect(withoutAnchor.reason).toMatch(/no prune anchor/)
  })

  it('does not let a stale anchor excuse a deletion above it', async () => {
    const records = chainOf(6)
    const anchor = { seq: records[1].seq, hash: records[1].hash }
    // Retention pruned through seq 1; seq 3 was then deleted by hand.
    const retained = [records[2], records[4], records[5]]

    const result = await verifyChain(retained, anchor)
    expect(result.status).toBe('broken')
    expect(result.brokenAt).toBe(4)
  })

  it('verifies an async stream the same way it verifies an array', async () => {
    const records = chainOf(3)
    async function* stream() {
      for (const entry of records) yield entry
    }
    expect(await verifyChain(stream())).toMatchObject({ status: 'intact', checked: 3 })
  })
})

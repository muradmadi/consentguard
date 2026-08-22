import { createHash } from 'crypto'
import type { AuditRecord, ChainStatus, SealedAuditRecord } from '@sluice/shared'

/** The `prevHash` of the first record ever written. */
export const GENESIS_HASH = '0'.repeat(64)

export interface ChainHead {
  seq: number
  hash: string
}

/**
 * Serialise a value with object keys in a stable order.
 *
 * A record is hashed when it is written and re-hashed when it is verified, and
 * the two only agree if key order does. `JSON.stringify` preserves insertion
 * order, which survives a round trip through the file but not necessarily
 * through a re-parse-and-rebuild elsewhere, so order is pinned here rather than
 * assumed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
}

/** The digest of a record, computed over everything except the digest itself. */
export function hashRecord(record: Omit<SealedAuditRecord, 'hash'>): string {
  return createHash('sha256').update(canonicalJson(record)).digest('hex')
}

/**
 * Put a record at the end of the chain.
 *
 * The caller serialises calls to this: two records sealed against the same head
 * would both claim the same `seq` and neither would verify.
 */
export function sealRecord(record: AuditRecord, head: ChainHead | null): SealedAuditRecord {
  const unsealed = {
    ...record,
    seq: head ? head.seq + 1 : 0,
    prevHash: head ? head.hash : GENESIS_HASH,
  }
  return { ...unsealed, hash: hashRecord(unsealed) }
}

/**
 * Walk a run of records oldest-first and report whether the chain holds.
 *
 * `anchor` is the `{ seq, hash }` recorded when retention last pruned a
 * segment. It is what tells a legitimately shortened chain apart from a
 * tampered one: without it, a first record whose `seq` is not 0 could equally
 * be an expired prefix or a deleted one, so that case reports `truncated` and
 * says so rather than crying `broken`.
 *
 * What this catches is an edit, a deletion, a reorder, or an insertion made by
 * someone with write access to the records. What it does not catch is someone
 * who rewrites every record *and* the anchor — re-chaining a whole directory is
 * cheap. Detecting that needs the head hash held somewhere the attacker is not,
 * which is why `/api/health` publishes it.
 *
 * Records may arrive as an array or as an async stream, so verifying a full
 * history never means holding one in memory.
 */
export async function verifyChain(
  records: Iterable<SealedAuditRecord> | AsyncIterable<SealedAuditRecord>,
  anchor: ChainHead | null = null,
): Promise<ChainStatus> {
  let expectedPrev: string | null = null
  let previous: SealedAuditRecord | null = null
  let status: ChainStatus['status'] = 'intact'
  let reason: string | undefined
  let checked = 0

  for await (const record of records) {
    if (expectedPrev === null) {
      if (anchor && anchor.seq === record.seq - 1) {
        expectedPrev = anchor.hash
      } else if (record.seq === 0) {
        expectedPrev = GENESIS_HASH
      } else {
        // No anchor covers the gap. The records that remain may all be sound,
        // so keep checking them and report the shortfall rather than a break.
        status = 'truncated'
        reason = anchor
          ? `oldest retained record is seq ${record.seq}, but the newest prune anchor is seq ${anchor.seq}`
          : `oldest retained record is seq ${record.seq} with no prune anchor to attach it to`
        expectedPrev = record.prevHash
      }
    }

    const { hash, ...unsealed } = record

    if (record.prevHash !== expectedPrev) {
      return broken(
        checked,
        record.seq,
        `record ${record.seq} does not link to the record before it`,
      )
    }
    if (hashRecord(unsealed) !== hash) {
      return broken(
        checked,
        record.seq,
        `record ${record.seq} has been altered since it was written`,
      )
    }
    if (previous && record.seq !== previous.seq + 1) {
      return broken(
        checked,
        record.seq,
        `record ${record.seq} follows ${previous.seq} out of order`,
      )
    }

    expectedPrev = hash
    previous = record
    checked++
  }

  if (!previous) return { status: 'intact', checked: 0, head: null }

  return { status, checked, head: { seq: previous.seq, hash: previous.hash }, reason }
}

function broken(checked: number, seq: number, reason: string): ChainStatus {
  return { status: 'broken', checked, head: null, brokenAt: seq, reason }
}

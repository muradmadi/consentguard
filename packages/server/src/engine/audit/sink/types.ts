import type { AuditPage, ChainStatus, SealedAuditRecord } from '@sluice/shared'
import type { ChainHead } from '../chain'

/**
 * A filter over the retained record. Every field is optional; the empty query
 * is "the most recent page". Times are ISO 8601 strings, compared as strings —
 * the audit's own timestamps are ISO, and ISO sorts lexicographically.
 */
export interface AuditQuery {
  from?: string
  to?: string
  destination?: string
  decision?: SealedAuditRecord['decision']
  detector?: string
  userId?: string
  /** How many records to return. */
  limit?: number
  /** Resume below this `seq`. Newest-first, so "below" means older. */
  cursor?: number
}

export interface SinkStatus {
  /** False when no durable sink is configured — the audit is a cache only. */
  configured: boolean
  kind: string
  /** False once a write has failed and not yet succeeded again. */
  healthy: boolean
  location: string | null
  entries: number
  oldest: string | null
  newest: string | null
  retentionDays: number | null
  head: ChainHead | null
  lastError: string | null
}

/**
 * The durable, append-only record. Everything the firewall decides is written
 * here; the Redis list in front of it is a display cache that may roll over.
 *
 * Implementations must be append-only in the strict sense: there is no update
 * and no delete beyond retention, and retention records what it removed.
 */
export interface AuditSink {
  readonly kind: string
  readonly configured: boolean

  /** Recover the chain head and any prune anchors. Safe to call more than once. */
  init(): Promise<void>

  append(record: SealedAuditRecord): Promise<void>

  /** Newest first, filtered and paged. */
  query(query: AuditQuery): Promise<AuditPage>

  /** Re-hash everything retained and report whether the chain holds. */
  verify(): Promise<ChainStatus>

  status(): Promise<SinkStatus>

  /** The last record written, or null if the sink is empty. */
  head(): ChainHead | null

  /**
   * Whether the sink is currently able to record. A configured sink that has
   * failed to write reports false, which stops the firewall forwarding: if we
   * cannot prove what we did, we stop doing it.
   */
  healthy(): boolean
}

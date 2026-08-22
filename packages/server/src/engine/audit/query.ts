import type { SealedAuditRecord } from '@sluice/shared'
import type { AuditQuery } from './sink/types'

/** How many records a page returns when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 100

/** The ceiling on a single page, export included. */
export const MAX_PAGE_SIZE = 10_000

export function pageSize(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit) || limit < 1) return DEFAULT_PAGE_SIZE
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE)
}

/**
 * The one place a query is turned into a yes or no about a record.
 *
 * Both the durable sink and the cache fallback run records through this, so a
 * filter cannot mean one thing when the sink answers and another when the cache
 * does. `detector` matches against the transformations the value scan produced —
 * "show me every request where an email was found" is the question an operator
 * actually asks.
 */
export function matchesQuery(record: SealedAuditRecord, query: AuditQuery): boolean {
  if (query.from && record.timestamp < query.from) return false
  if (query.to && record.timestamp > query.to) return false
  if (query.destination && record.destination !== query.destination) return false
  if (query.decision && record.decision !== query.decision) return false
  if (query.userId && record.userId !== query.userId) return false
  if (query.detector && !record.transformations.some((t) => t.detector === query.detector)) {
    return false
  }
  return true
}

/** Newest-first paging: a cursor names the last `seq` already returned. */
export function afterCursor(record: SealedAuditRecord, cursor: number | undefined): boolean {
  return cursor === undefined ? true : record.seq < cursor
}

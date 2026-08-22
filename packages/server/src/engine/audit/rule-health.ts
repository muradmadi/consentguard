import type {
  AuditPage,
  DestinationRule,
  PiiDetector,
  RuleHealth,
  RuleHealthReport,
  SealedAuditRecord,
} from '@sluice/shared'
import type { AuditQuery } from './sink/types'
import { MAX_PAGE_SIZE } from './query'

/** How many records to read before the answer becomes a floor rather than a total. */
export const DEFAULT_SCAN_LIMIT = 20_000

interface Queryable {
  query(query: AuditQuery): Promise<AuditPage>
}

interface Tally {
  matched: number
  lastFiredAt: string | null
}

/**
 * Which declared transformations have actually fired, per destination.
 *
 * A rule declares a path; whether that path exists in the payloads the vendor
 * really receives is a different question, and the only honest answer comes from
 * the audit. `matched: 0` is a dead rule — `mixpanel.ts` declares
 * `properties.$email`, a path nothing can produce while that destination has no
 * adapter, and this is the surface that says so.
 *
 * Derived from the retained record rather than kept as counters, for the same
 * reason the audit itself is: a number maintained alongside the thing it
 * describes drifts from it, and a declared count proves nothing.
 */
export async function deriveRuleHealth(
  source: Queryable,
  rules: DestinationRule[],
  options: { scanLimit?: number; from?: string; to?: string } = {},
): Promise<RuleHealthReport> {
  const scanLimit = options.scanLimit ?? DEFAULT_SCAN_LIMIT
  const declaredHits = new Map<string, Tally>()
  const detectorHits = new Map<string, Tally>()

  let recordsScanned = 0
  let cursor: number | undefined

  while (recordsScanned < scanLimit) {
    const page = await source.query({
      from: options.from,
      to: options.to,
      limit: Math.min(scanLimit - recordsScanned, MAX_PAGE_SIZE),
      cursor,
    })
    if (page.records.length === 0) break

    for (const record of page.records) tally(record, declaredHits, detectorHits)
    recordsScanned += page.records.length

    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }

  const destinations: RuleHealth[] = rules.map((rule) => ({
    destination: rule.id,
    declared: (rule.transformations ?? []).map((transformation) => {
      const hit = declaredHits.get(key(rule.id, transformation.path))
      return {
        path: transformation.path,
        action: transformation.action,
        matched: hit?.matched ?? 0,
        lastFiredAt: hit?.lastFiredAt ?? null,
      }
    }),
    detected: detectorsFor(rule.id, detectorHits),
  }))

  return {
    destinations,
    recordsScanned,
    scanLimit,
    truncated: recordsScanned >= scanLimit,
  }
}

/**
 * Records arrive newest first, so the first sighting of a path is its most
 * recent firing.
 */
function tally(
  record: SealedAuditRecord,
  declaredHits: Map<string, Tally>,
  detectorHits: Map<string, Tally>,
): void {
  for (const entry of record.transformations) {
    // A `?` prefix means the entry came from the query string. It is the same
    // declared path either way — `scrubUrl` runs the rule over the parameters —
    // so both halves of the request credit the rule that caught it.
    const path = entry.path.startsWith('?') ? entry.path.slice(1) : entry.path
    const target = entry.detector ? detectorHits : declaredHits
    const id = key(record.destination, entry.detector ?? path)
    const existing = target.get(id)
    if (existing) existing.matched += entry.matched
    else target.set(id, { matched: entry.matched, lastFiredAt: record.timestamp })
  }
}

function detectorsFor(
  destination: string,
  detectorHits: Map<string, Tally>,
): RuleHealth['detected'] {
  const prefix = key(destination, '')
  return [...detectorHits.entries()]
    .filter(([id]) => id.startsWith(prefix))
    .map(([id, hit]) => ({
      detector: id.slice(prefix.length) as PiiDetector,
      matched: hit.matched,
    }))
    .sort((a, b) => b.matched - a.matched)
}

/** A NUL separator, which neither a destination id nor a dotted path contains. */
function key(destination: string, suffix: string): string {
  return `${destination}\u0000${suffix}`
}

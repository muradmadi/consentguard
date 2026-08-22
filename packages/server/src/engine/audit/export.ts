import type { SealedAuditRecord } from '@sluice/shared'

/**
 * One record per line, exactly as it was written to the sink.
 *
 * The hash fields travel with it, so an exported file can be re-verified
 * against the chain rather than taken on trust.
 */
export function toNdjson(records: SealedAuditRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '')
}

const COLUMNS = [
  'seq',
  'timestamp',
  'userId',
  'destination',
  'decision',
  'reason',
  'purposesRequired',
  'purposesGranted',
  'transformations',
  'prevHash',
  'hash',
] as const

/**
 * The same records as a spreadsheet, because that is what gets attached to a
 * regulator's email.
 *
 * `transformations` is flattened to `action path ×n (source)` — enough to read
 * without a JSON parser, and still never the removed value itself. A hash says
 * which hash: a match key is a digest the vendor can join on, a pseudonym is
 * not, and a reader cannot tell them apart from the word "hash".
 */
export function toCsv(records: SealedAuditRecord[]): string {
  const rows = records.map((record) =>
    [
      record.seq,
      record.timestamp,
      record.userId,
      record.destination,
      record.decision,
      record.reason,
      record.purposesRequired ?? '',
      (record.purposesGranted ?? []).join(' '),
      record.transformations
        .map(
          (t) =>
            `${t.action}${t.mode ? `:${t.mode}` : ''} ${t.path} ×${t.matched} (${t.detector ?? 'declared'})`,
        )
        .join('; '),
      record.prevHash,
      record.hash,
    ]
      .map(csvCell)
      .join(','),
  )

  return [COLUMNS.join(','), ...rows].join('\n') + '\n'
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

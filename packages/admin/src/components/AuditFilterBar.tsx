import type { AuditFilters } from '../lib/api'

const DETECTORS = ['email', 'phone', 'ipv4', 'ipv6', 'credit_card', 'us_ssn']
const DECISIONS = ['forwarded', 'blocked', 'failed']

/**
 * The controls that turn the audit into an answer.
 *
 * The question an operator is asked is never "show me the last hundred
 * requests"; it is "show me everything that went to this vendor in this window,
 * and where an email was involved".
 */
export function AuditFilterBar({
  filters,
  destinations,
  onChange,
  onExport,
  exporting,
}: {
  filters: AuditFilters
  destinations: string[]
  onChange: (next: AuditFilters) => void
  onExport: (format: 'csv' | 'ndjson') => void
  exporting: boolean
}) {
  const set = (key: keyof AuditFilters, value: string) =>
    onChange({ ...filters, [key]: value === '' ? undefined : value })

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '12px',
        alignItems: 'flex-end',
        marginBottom: '20px',
      }}
    >
      <Field label="From">
        <input
          type="datetime-local"
          aria-label="From"
          value={toLocalInput(filters.from)}
          onChange={(e) => set('from', fromLocalInput(e.target.value))}
        />
      </Field>
      <Field label="To">
        <input
          type="datetime-local"
          aria-label="To"
          value={toLocalInput(filters.to)}
          onChange={(e) => set('to', fromLocalInput(e.target.value))}
        />
      </Field>
      <Field label="Destination">
        <select
          aria-label="Destination"
          value={filters.destination ?? ''}
          onChange={(e) => set('destination', e.target.value)}
        >
          <option value="">All</option>
          {destinations.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Decision">
        <select
          aria-label="Decision"
          value={filters.decision ?? ''}
          onChange={(e) => set('decision', e.target.value)}
        >
          <option value="">All</option>
          {DECISIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Detector">
        <select
          aria-label="Detector"
          value={filters.detector ?? ''}
          onChange={(e) => set('detector', e.target.value)}
        >
          <option value="">Any</option>
          {DETECTORS.map((d) => (
            <option key={d} value={d}>
              {d.replace('_', ' ')}
            </option>
          ))}
        </select>
      </Field>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
        <button className="btn btn-secondary" onClick={() => onChange({})}>
          Clear
        </button>
        <button className="btn btn-secondary" disabled={exporting} onClick={() => onExport('csv')}>
          Export CSV
        </button>
        <button
          className="btn btn-secondary"
          disabled={exporting}
          onClick={() => onExport('ndjson')}
        >
          Export NDJSON
        </button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '11px', color: 'var(--accents-4)' }}>{label}</label>
      {children}
    </div>
  )
}

/**
 * The filter travels as UTC, the input shows local time. Converting in both
 * directions here keeps every other layer on ISO.
 */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fromLocalInput(value: string): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

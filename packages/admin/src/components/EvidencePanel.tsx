import type { ChainStatus } from '@sluice/shared'
import { chainLabel, shortHash, type Health } from '../lib/health'

/**
 * The header status card, rendered from measurements rather than from literals.
 *
 * It used to read "System Healthy · Redis: Connected" whatever the proxy was
 * actually doing. In a product whose claim is that its reporting is derived, an
 * operator surface that asserts is the same defect as an audit built from a
 * rule's declarations.
 */
export function StatusCard({ health }: { health: Health | null }) {
  const ok = health?.status === 'ok'
  const colour = !health ? '#666' : ok ? '#0070f3' : '#ee0000'

  return (
    <div
      className="card"
      style={{
        padding: '12px 20px',
        margin: 0,
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        border: '1px solid #333',
      }}
    >
      <div
        style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: colour,
          boxShadow: `0 0 8px ${colour}`,
        }}
      ></div>
      <div style={{ fontSize: '13px', fontWeight: 600 }}>
        {!health ? 'Awaiting probe' : ok ? 'System healthy' : 'System degraded'}
      </div>
      <div style={{ height: '16px', width: '1px', background: '#333' }}></div>
      <div style={{ fontSize: '12px', color: 'var(--accents-4)' }}>
        {!health
          ? 'Storage: unknown'
          : `${storageName(health.storage.kind)}: ${
              health.storage.ok ? `responding in ${health.storage.latencyMs}ms` : 'not responding'
            }`}
      </div>
    </div>
  )
}

/**
 * What the durable record actually holds.
 *
 * "Prove no email reached this vendor last Tuesday" is answerable only if the
 * record goes back that far, so how far back it goes is the number worth putting
 * on the page.
 */
export function EvidencePanel({
  health,
  chain,
  onVerify,
  verifying,
}: {
  health: Health | null
  chain: ChainStatus | null
  onVerify: () => void
  verifying: boolean
}) {
  const audit = health?.audit
  const label = chainLabel(chain)

  if (audit && !audit.configured) {
    return (
      <div className="card" style={{ border: '1px solid #ee0000' }}>
        <h3>Evidence</h3>
        <div style={{ fontSize: '13px', marginTop: '8px' }}>No durable audit record.</div>
        <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
          The audit is a {audit.cacheEntries}-entry cache that rolls over silently. Set
          SLUICE_AUDIT_DIR to keep records that outlive the process.
        </p>
      </div>
    )
  }

  return (
    <div className="card">
      <h3>Evidence</h3>
      <div className="stat-value">{audit ? audit.entries.toLocaleString() : '—'}</div>
      <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
        Records retained{audit?.retentionDays ? ` for ${audit.retentionDays} days` : ''}
      </p>

      <dl
        style={{
          margin: '16px 0 0',
          display: 'grid',
          gridTemplateColumns: 'auto 1fr',
          gap: '6px 12px',
          fontSize: '12px',
        }}
      >
        <dt style={{ color: 'var(--accents-4)' }}>Oldest</dt>
        <dd style={{ margin: 0 }}>
          {audit?.oldest ? new Date(audit.oldest).toLocaleString() : 'nothing recorded yet'}
        </dd>
        <dt style={{ color: 'var(--accents-4)' }}>Head</dt>
        <dd style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>
          {audit?.head ? `#${audit.head.seq} ${shortHash(audit.head.hash)}` : '—'}
        </dd>
        <dt style={{ color: 'var(--accents-4)' }}>Written to</dt>
        <dd style={{ margin: 0, wordBreak: 'break-all' }}>{audit?.location ?? '—'}</dd>
      </dl>

      {audit && !audit.evidenceAvailable && (
        <div
          className="badge badge-error"
          style={{ marginTop: '12px', display: 'inline-block' }}
          title={audit.lastError ?? undefined}
        >
          Not recording — forwarding stopped
        </div>
      )}

      <div style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '12px' }}>
        <button className="btn btn-secondary" onClick={onVerify} disabled={verifying}>
          {verifying ? 'Verifying…' : 'Verify chain'}
        </button>
        {chain && (
          <span className={`badge ${label.ok ? 'badge-success' : 'badge-error'}`}>
            {label.text}
          </span>
        )}
      </div>
      {chain?.reason && (
        <p style={{ marginTop: '8px', fontSize: '11px', color: 'var(--accents-4)' }}>
          {chain.reason}
        </p>
      )}
    </div>
  )
}

/** `RedisStorageProvider` is not what an operator calls it. */
function storageName(kind: string): string {
  return kind.replace(/StorageProvider$/, '')
}

import { useState, useEffect, useCallback } from 'react'
import { Shield, ChevronRight, AlertCircle } from 'lucide-react'
import {
  downloadAudit,
  fetchAudit,
  fetchHealth,
  fetchRuleHealth,
  fetchRules,
  fetchStats,
  updateRule,
  UnauthorizedError,
  verifyAudit,
  type AuditFilters,
} from './lib/api'
import { getToken, setToken, clearToken } from './lib/auth'
import { TokenGate } from './components/TokenGate'
import { RuleEditor } from './components/RuleEditor'
import { LiveTraffic } from './components/LiveTraffic'
import { AuditFilterBar } from './components/AuditFilterBar'
import { EvidencePanel, StatusCard } from './components/EvidencePanel'
import type { RuleHealthReport, SealedAuditRecord, DestinationRuleView } from '@sluice/shared'
import type { ChainStatus } from '@sluice/shared'
import { shortHash, type Health } from './lib/health'

/** Blocked and failed both mean nothing reached the vendor, but for different reasons. */
function decisionBadge(decision: SealedAuditRecord['decision']): string {
  if (decision === 'blocked' || decision === 'failed') return 'badge-error'
  return 'badge-success'
}

/**
 * What the proxy can actually do with a destination, as the proxy derived it.
 *
 * The registry used to list six destinations and serve one, and no operator
 * surface said so. This is not computed here for the same reason the audit is
 * not built from a rule: only the proxy knows which adapters its build
 * registers, so the dashboard reports what it was told.
 */
const SUPPORT: Record<string, { badge: string; title: string }> = {
  adapter: {
    badge: 'badge-success',
    title: "A vendor adapter translates the beacon into this vendor's server-side API.",
  },
  passthrough: {
    badge: 'badge-secondary',
    title:
      'No adapter: the scrubbed beacon is forwarded to the endpoint the browser targeted. Real support for a transport both scrub passes can read.',
  },
  unsupported: {
    badge: 'badge-error',
    title:
      'Refused at /ingest. The payload is encoded, so it cannot be scrubbed — and an unscrubbable payload is not forwarded.',
  },
}

function SupportBadge({ rule }: { rule: DestinationRuleView }) {
  const support = SUPPORT[rule.support] ?? SUPPORT.unsupported
  return (
    <span
      className={`badge ${support.badge}`}
      title={`${support.title} Transport: ${rule.transport}.`}
    >
      {rule.support}
    </span>
  )
}

/**
 * Where an entry came from: a declared rule path, or the value scan that found
 * personal data nobody had written a rule for.
 */
function originLabel(t: SealedAuditRecord['transformations'][number]): string {
  return t.detector ? `detected ${t.detector.replace('_', ' ')}` : 'declared rule'
}

function describeTransformations(log: SealedAuditRecord): string {
  return log.transformations
    .map((t) => `${t.action} ${t.path} (×${t.matched}, ${originLabel(t)})`)
    .join(', ')
}

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [ruleHealth, setRuleHealth] = useState<RuleHealthReport | null>(null)
  const [rules, setRules] = useState<DestinationRuleView[]>([])
  const [logs, setLogs] = useState<SealedAuditRecord[]>([])
  const [nextCursor, setNextCursor] = useState<number | null>(null)
  const [filters, setFilters] = useState<AuditFilters>({})
  const [chain, setChain] = useState<ChainStatus | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [selectedRule, setSelectedRule] = useState<DestinationRuleView | null>(null)
  const [selectedLog, setSelectedLog] = useState<SealedAuditRecord | null>(null)
  const [, setIsLoading] = useState(false)
  const [authed, setAuthed] = useState(() => getToken() !== '')
  const [authError, setAuthError] = useState('')

  /** A rejected token means the operator mistyped it or it was rotated. */
  const handleUnauthorized = useCallback(() => {
    clearToken()
    setAuthed(false)
    setAuthError('That token was rejected by the proxy.')
  }, [])

  useEffect(() => {
    if (!authed) return

    const loadData = async () => {
      try {
        // The audit page is filtered server-side, so a narrowed view polls the
        // same query rather than re-filtering a stale hundred rows in the browser.
        const [s, r, page, h, rh] = await Promise.all([
          fetchStats(),
          fetchRules(),
          fetchAudit(filters),
          fetchHealth(),
          fetchRuleHealth(),
        ])
        setStats(s)
        setRules(r)
        setLogs(page.records)
        setNextCursor(page.nextCursor)
        setHealth(h)
        setRuleHealth(rh)
      } catch (e) {
        if (e instanceof UnauthorizedError) return handleUnauthorized()
        console.error('Failed to load data', e)
      }
    }
    loadData()
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [authed, filters, handleUnauthorized])

  /** Append the next page rather than replacing it; polling resets to page one. */
  const loadMore = async () => {
    if (nextCursor === null) return
    try {
      const page = await fetchAudit({ ...filters, cursor: nextCursor })
      setLogs((current) => [...current, ...page.records])
      setNextCursor(page.nextCursor)
    } catch (e) {
      if (e instanceof UnauthorizedError) return handleUnauthorized()
      console.error('[Sluice] Failed to load more audit records', e)
    }
  }

  const handleVerify = async () => {
    setVerifying(true)
    try {
      setChain(await verifyAudit())
    } catch (e) {
      if (e instanceof UnauthorizedError) return handleUnauthorized()
      console.error('[Sluice] Chain verification failed', e)
    } finally {
      setVerifying(false)
    }
  }

  const handleExport = async (format: 'csv' | 'ndjson') => {
    setExporting(true)
    try {
      await downloadAudit(format, filters)
    } catch (e) {
      if (e instanceof UnauthorizedError) return handleUnauthorized()
      console.error('[Sluice] Export failed', e)
    } finally {
      setExporting(false)
    }
  }

  /** What a rule's declared path has actually done, keyed for the chips below. */
  const firingCounts = new Map<string, number>()
  for (const destination of ruleHealth?.destinations ?? []) {
    for (const declared of destination.declared) {
      firingCounts.set(`${destination.destination}/${declared.path}`, declared.matched)
    }
  }

  const handleSaveRule = async (updatedRule: DestinationRuleView) => {
    setIsLoading(true)
    try {
      await updateRule(updatedRule.id, updatedRule)
      setRules(rules.map((r) => (r.id === updatedRule.id ? updatedRule : r)))
      setSelectedRule(null)
    } catch (e) {
      if (e instanceof UnauthorizedError) return handleUnauthorized()
      console.error('[Sluice] Failed to save rule', e)
      alert('Failed to save rule')
    } finally {
      setIsLoading(false)
    }
  }

  if (!authed) {
    return (
      <TokenGate
        error={authError}
        onSubmit={(token) => {
          setToken(token)
          setAuthError('')
          setAuthed(true)
        }}
      />
    )
  }

  return (
    <div className="app-container">
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield size={24} color="#fff" />
          <h3 style={{ margin: 0, letterSpacing: '-0.02em' }}>Sluice</h3>
          <span className="badge badge-success" style={{ marginLeft: '8px', fontSize: '10px' }}>
            Beta
          </span>
        </div>
        <nav className="nav-links">
          <a
            href="#"
            onClick={() => setActiveTab('dashboard')}
            className={`nav-link ${activeTab === 'dashboard' ? 'active' : ''}`}
          >
            Dashboard
          </a>
          <a
            href="#"
            onClick={() => setActiveTab('rules')}
            className={`nav-link ${activeTab === 'rules' ? 'active' : ''}`}
          >
            Governance
          </a>
          <a
            href="#"
            onClick={() => setActiveTab('registry')}
            className={`nav-link ${activeTab === 'registry' ? 'active' : ''}`}
          >
            Registry
          </a>
          <a
            href="#"
            onClick={() => setActiveTab('audit')}
            className={`nav-link ${activeTab === 'audit' ? 'active' : ''}`}
          >
            Audit Log
          </a>
        </nav>
      </header>

      <main>
        {activeTab === 'dashboard' && (
          <div className="fade-in">
            <div
              style={{
                marginBottom: '32px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <h1 style={{ marginBottom: '8px' }}>Overview</h1>
                <p>Real-time monitoring of your privacy enforcement layer.</p>
              </div>
              <StatusCard health={health} />
            </div>

            <div
              className="stats-grid"
              style={{ gridTemplateColumns: '2fr 1fr', gap: '24px', alignItems: 'start' }}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '24px' }}>
                <div className="card">
                  <h3>Forwarded</h3>
                  <div className="stat-value" style={{ color: '#0070f3' }}>
                    {stats?.decisions?.forwarded || 0}
                  </div>
                  <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
                    Active requests being processed
                  </p>
                </div>
                <div className="card">
                  <h3>Blocked</h3>
                  <div className="stat-value" style={{ color: '#ee0000' }}>
                    {stats?.decisions?.blocked || 0}
                  </div>
                  <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
                    Prevented data leaks
                  </p>
                </div>
                <div className="card">
                  <h3>System Errors</h3>
                  <div className="stat-value">{stats?.errors || 0}</div>
                  <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
                    Connection or proxy failures
                  </p>
                </div>
                <EvidencePanel
                  health={health}
                  chain={chain}
                  onVerify={handleVerify}
                  verifying={verifying}
                />
              </div>

              <LiveTraffic logs={logs} />
            </div>

            <h2 style={{ margin: '48px 0 24px' }}>Recent Audit Logs</h2>
            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>USER ID</th>
                    <th>DESTINATION</th>
                    <th>DECISION</th>
                    <th>REASON</th>
                    <th>TIMESTAMP</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.slice(0, 10).map((log, i) => (
                    <tr key={i} onClick={() => setSelectedLog(log)} style={{ cursor: 'pointer' }}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                        {log.userId}
                      </td>
                      <td>{log.destination}</td>
                      <td>
                        <span className={`badge ${decisionBadge(log.decision)}`}>
                          {log.decision}
                        </span>
                        {log.transformations.length > 0 && (
                          <span
                            className="badge"
                            style={{ marginLeft: '6px', opacity: 0.8 }}
                            title={describeTransformations(log)}
                          >
                            {log.transformations.length} scrubbed
                          </span>
                        )}
                      </td>
                      <td style={{ color: 'var(--accents-5)' }}>{log.reason}</td>
                      <td style={{ color: 'var(--accents-4)', fontSize: '12px' }}>
                        {new Date(log.timestamp).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'rules' && (
          <div className="fade-in">
            <div
              style={{
                marginBottom: '32px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-end',
              }}
            >
              <div>
                <h1 style={{ marginBottom: '8px' }}>Destination Rules</h1>
                <p>
                  Manage how Sluice transforms data for each provider. Counts are what each declared
                  path actually matched over the{' '}
                  {ruleHealth ? ruleHealth.recordsScanned.toLocaleString() : '—'} most recent
                  retained records
                  {ruleHealth?.truncated ? ' (the scan limit, so counts are a floor)' : ''}.
                </p>
              </div>
              <button className="btn">Add Destination</button>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>CATEGORY</th>
                    <th>SUPPORT</th>
                    <th>TRANSFORMATIONS</th>
                    <th>ACTIONS</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td style={{ fontWeight: 600 }}>{rule.id}</td>
                      <td>
                        <span className="badge badge-secondary">{rule.category}</span>
                      </td>
                      <td>
                        <SupportBadge rule={rule} />
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {rule.transformations.map((t: any, i: number) => {
                            // A declared path that has never matched is a rule
                            // nobody is protected by. Only the audit knows.
                            const matched = firingCounts.get(`${rule.id}/${t.path}`)
                            const dead = ruleHealth !== null && matched === 0
                            return (
                              <span
                                key={i}
                                title={
                                  dead
                                    ? 'Never fired over the retained record — this path may not exist in what this destination sends'
                                    : `Fired ${matched ?? 0} times over the retained record`
                                }
                                style={{
                                  fontSize: '10px',
                                  background: '#111',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  border: `1px solid ${dead ? '#ee0000' : '#333'}`,
                                  color: dead ? '#ee0000' : undefined,
                                }}
                              >
                                {t.action}:{t.path}
                                {matched !== undefined && ` ×${matched}`}
                              </span>
                            )
                          })}
                        </div>
                      </td>
                      <td>
                        <button
                          className="btn btn-secondary"
                          style={{ padding: '4px 12px' }}
                          onClick={() => setSelectedRule(rule)}
                        >
                          Edit
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'registry' && (
          <div className="fade-in">
            <div style={{ marginBottom: '32px' }}>
              <h1 style={{ marginBottom: '8px' }}>Global Registry</h1>
              <p>The universal list of destinations Sluice can protect out-of-the-box.</p>
            </div>

            {/*
              There used to be a "Coverage" tile here reading rules.length / 50.
              There is no global registry of fifty destinations, so the number
              measured nothing. A missing metric is better than an invented one.
            */}
            <div
              className="stats-grid"
              style={{ gridTemplateColumns: 'repeat(2, 1fr)', marginBottom: '32px' }}
            >
              <div className="card">
                <h3>Total Rules</h3>
                <div className="stat-value">{rules.length}</div>
              </div>
              <div className="card">
                <h3>Overrides</h3>
                <div className="stat-value" style={{ color: '#0070f3' }}>
                  {rules.filter((r: any) => (r as any)._isOverride).length}
                </div>
              </div>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>DESTINATION</th>
                    <th>ENDPOINTS</th>
                    <th>SUPPORT</th>
                    <th>STATUS</th>
                  </tr>
                </thead>
                <tbody>
                  {/* Highlight Unknown Destinations from Logs */}
                  {Array.from(new Set(logs.map((l) => l.destination)))
                    .filter((d) => !rules.find((r) => r.id === d))
                    .map((unknown) => (
                      <tr key={unknown} style={{ background: 'rgba(238, 0, 0, 0.05)' }}>
                        <td
                          style={{
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <AlertCircle size={14} color="#ee0000" />
                          {unknown}
                        </td>
                        <td style={{ color: 'var(--accents-4)', fontSize: '12px' }}>
                          Unknown (Captured from traffic)
                        </td>
                        <td>
                          {/* getDefaultRule declares no transport, so /ingest
                              refuses it — the same answer the registry gives. */}
                          <span
                            className="badge badge-error"
                            title="Refused at /ingest: a destination nobody declared has no transport we can scrub."
                          >
                            unsupported
                          </span>
                        </td>
                        <td>
                          <span className="badge badge-error">Action Required</span>
                        </td>
                      </tr>
                    ))}
                  {rules.map((rule) => (
                    <tr key={rule.id}>
                      <td style={{ fontWeight: 600 }}>{rule.id}</td>
                      <td style={{ color: 'var(--accents-4)', fontSize: '12px' }}>
                        {rule.endpoints.join(', ')}
                      </td>
                      <td>
                        <SupportBadge rule={rule} />
                      </td>
                      <td>
                        {(rule as any)._isOverride ? (
                          <span
                            className="badge badge-success"
                            style={{
                              background: 'rgba(0, 112, 243, 0.1)',
                              border: '1px solid #0070f3',
                              color: '#0070f3',
                            }}
                          >
                            Active Override
                          </span>
                        ) : (
                          <span className="badge badge-secondary">Default</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        {activeTab === 'audit' && (
          <div className="card" style={{ padding: '24px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: '16px',
              }}
            >
              <h2 style={{ margin: 0 }}>Full Audit History</h2>
              <span style={{ fontSize: '12px', color: 'var(--accents-4)' }}>
                {health?.audit.configured
                  ? `${health.audit.entries.toLocaleString()} records retained${
                      health.audit.retentionDays ? ` for ${health.audit.retentionDays} days` : ''
                    }`
                  : 'No durable record — showing the display cache'}
              </span>
            </div>

            <AuditFilterBar
              filters={filters}
              destinations={rules.map((r) => r.id)}
              onChange={setFilters}
              onExport={handleExport}
              exporting={exporting}
            />

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>USER ID</th>
                    <th>DESTINATION</th>
                    <th>DECISION</th>
                    <th>REASON</th>
                    <th>TIMESTAMP</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length > 0 ? (
                    logs.map((log, i) => (
                      <tr key={i} onClick={() => setSelectedLog(log)} style={{ cursor: 'pointer' }}>
                        <td>
                          <code style={{ fontSize: '11px' }}>{log.userId}</code>
                        </td>
                        <td>
                          <strong>{log.destination}</strong>
                        </td>
                        <td>
                          <span className={`badge ${decisionBadge(log.decision)}`}>
                            {log.decision.toUpperCase()}
                          </span>
                          {log.transformations.length > 0 && (
                            <span
                              className="badge"
                              style={{ marginLeft: '6px', opacity: 0.8 }}
                              title={describeTransformations(log)}
                            >
                              {log.transformations.length} scrubbed
                            </span>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: '12px', color: 'var(--accents-4)' }}>
                            {log.reason}
                          </span>
                        </td>
                        <td>{new Date(log.timestamp).toLocaleTimeString()}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td
                        colSpan={5}
                        style={{ textAlign: 'center', padding: '40px', color: 'var(--accents-4)' }}
                      >
                        No records match this filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {nextCursor !== null && (
              <div style={{ marginTop: '16px', textAlign: 'center' }}>
                <button className="btn btn-secondary" onClick={loadMore}>
                  Load older records
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {selectedRule && (
        <RuleEditor
          rule={selectedRule}
          onClose={() => setSelectedRule(null)}
          onSave={handleSaveRule}
        />
      )}

      {selectedLog && (
        <div className="modal-overlay" onClick={() => setSelectedLog(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Audit Detail</h2>
              <button className="btn-icon" onClick={() => setSelectedLog(null)}>
                <ChevronRight size={20} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>User ID</label>
                <div style={{ fontFamily: 'var(--font-mono)' }}>{selectedLog.userId}</div>
              </div>
              <div className="form-group">
                <label>Destination</label>
                <div>{selectedLog.destination}</div>
              </div>
              <div className="form-group">
                <label>Decision</label>
                <span className={`badge ${decisionBadge(selectedLog.decision)}`}>
                  {selectedLog.decision}
                </span>
              </div>
              <div className="form-group">
                <label>Personal Data Removed</label>
                {selectedLog.transformations.length === 0 ? (
                  <div style={{ fontSize: '13px', color: 'var(--accents-4)' }}>
                    Nothing matched — this payload carried none of the declared fields and no
                    detectable personal data.
                  </div>
                ) : (
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {selectedLog.transformations.map((t, i) => (
                      <li
                        key={i}
                        style={{
                          padding: '4px 0',
                          borderBottom: '1px solid var(--accents-1)',
                          fontSize: '13px',
                          display: 'flex',
                          justifyContent: 'space-between',
                          gap: '12px',
                        }}
                      >
                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <code>{t.path}</code>
                          <span
                            className="badge"
                            style={{ opacity: 0.7, fontSize: '11px', whiteSpace: 'nowrap' }}
                          >
                            {originLabel(t)}
                          </span>
                        </span>
                        <span style={{ color: 'var(--accents-4)', whiteSpace: 'nowrap' }}>
                          {t.action} × {t.matched}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="form-group">
                <label>Reason</label>
                <p>{selectedLog.reason}</p>
              </div>
              <div className="form-group">
                {/* The record's position in the chain: what makes it checkable. */}
                <label>Chain position</label>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>
                  #{selectedLog.seq} · {shortHash(selectedLog.hash)}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: '11px',
                    color: 'var(--accents-4)',
                  }}
                >
                  follows {shortHash(selectedLog.prevHash)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

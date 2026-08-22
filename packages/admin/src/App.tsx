import { useState, useEffect } from 'react'
import { Shield, ChevronRight } from 'lucide-react'
import { fetchStats, fetchRules, fetchAuditLogs, updateRule } from './lib/api'
import { RuleEditor } from './components/RuleEditor'
import { LiveTraffic } from './components/LiveTraffic'
import { AlertCircle } from 'lucide-react'
import type { DestinationRule } from '@sluice/shared'

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [rules, setRules] = useState<DestinationRule[]>([])
  const [logs, setLogs] = useState<any[]>([])
  const [selectedRule, setSelectedRule] = useState<DestinationRule | null>(null)
  const [selectedLog, setSelectedLog] = useState<any | null>(null)
  const [, setIsLoading] = useState(false)

  useEffect(() => {
    const loadData = async () => {
      try {
        const [s, r, l] = await Promise.all([fetchStats(), fetchRules(), fetchAuditLogs()])
        setStats(s)
        setRules(r)
        setLogs(l)
      } catch (e) {
        console.error('Failed to load data', e)
      }
    }
    loadData()
    const interval = setInterval(loadData, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleSaveRule = async (updatedRule: DestinationRule) => {
    setIsLoading(true)
    try {
      await updateRule(updatedRule.id, updatedRule)
      setRules(rules.map((r) => (r.id === updatedRule.id ? updatedRule : r)))
      setSelectedRule(null)
    } catch (e) {
      console.error('[Sluice] Failed to save rule', e)
      alert('Failed to save rule')
    } finally {
      setIsLoading(false)
    }
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
                    background: '#0070f3',
                    boxShadow: '0 0 8px #0070f3',
                  }}
                ></div>
                <div style={{ fontSize: '13px', fontWeight: 600 }}>System Healthy</div>
                <div style={{ height: '16px', width: '1px', background: '#333' }}></div>
                <div style={{ fontSize: '12px', color: 'var(--accents-4)' }}>Redis: Connected</div>
              </div>
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
                <div className="card" style={{ gridColumn: 'span 2' }}>
                  <h3>System Errors</h3>
                  <div className="stat-value">{stats?.errors || 0}</div>
                  <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
                    Connection or proxy failures
                  </p>
                </div>
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
                        <span
                          className={`badge ${log.decision === 'blocked' ? 'badge-error' : log.decision === 'scrubbed' ? 'badge-success' : 'badge-success'}`}
                          style={{ opacity: log.decision === 'scrubbed' ? 0.8 : 1 }}
                        >
                          {log.decision}
                        </span>
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
                <p>Manage how Sluice transforms data for each provider.</p>
              </div>
              <button className="btn">Add Destination</button>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>CATEGORY</th>
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
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {rule.transformations.map((t: any, i: number) => (
                            <span
                              key={i}
                              style={{
                                fontSize: '10px',
                                background: '#111',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                border: '1px solid #333',
                              }}
                            >
                              {t.action}:{t.path}
                            </span>
                          ))}
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

            <div
              className="stats-grid"
              style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: '32px' }}
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
              <div className="card">
                <h3>Coverage</h3>
                <div className="stat-value" style={{ color: '#00ff00' }}>
                  {rules.length > 0 ? Math.round((rules.length / 50) * 100) : 0}%
                </div>
                <p style={{ marginTop: '8px', fontSize: '12px', color: 'var(--accents-4)' }}>
                  Of global destination registry
                </p>
              </div>
            </div>

            <div className="table-container">
              <table>
                <thead>
                  <tr>
                    <th>DESTINATION</th>
                    <th>ENDPOINTS</th>
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
            <h2 style={{ marginBottom: '24px' }}>Full Audit History</h2>
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
                    logs.map((log: any, i: number) => (
                      <tr key={i} onClick={() => setSelectedLog(log)} style={{ cursor: 'pointer' }}>
                        <td>
                          <code style={{ fontSize: '11px' }}>{log.userId}</code>
                        </td>
                        <td>
                          <strong>{log.destination}</strong>
                        </td>
                        <td>
                          <span
                            className={`badge ${log.decision === 'blocked' ? 'badge-error' : log.decision === 'buffered' ? '' : 'badge-success'}`}
                            style={
                              log.decision === 'buffered'
                                ? { background: '#0070f3', color: 'white', fontWeight: 600 }
                                : {}
                            }
                          >
                            {log.decision.toUpperCase()}
                          </span>
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
                        No audit logs found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
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
                <span
                  className={`badge ${selectedLog.decision === 'blocked' ? 'badge-error' : 'badge-success'}`}
                >
                  {selectedLog.decision}
                </span>
              </div>
              {selectedLog.transformationsApplied &&
                selectedLog.transformationsApplied.length > 0 && (
                  <div className="form-group">
                    <label>Transformations Applied</label>
                    <ul style={{ listStyle: 'none', padding: 0 }}>
                      {selectedLog.transformationsApplied.map((t: string, i: number) => (
                        <li
                          key={i}
                          style={{
                            padding: '4px 0',
                            borderBottom: '1px solid var(--accents-1)',
                            fontSize: '13px',
                          }}
                        >
                          <code>{t}</code>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              <div className="form-group">
                <label>Reason</label>
                <p>{selectedLog.reason}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default App

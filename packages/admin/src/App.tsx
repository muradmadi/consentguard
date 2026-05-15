import React, { useState, useEffect } from 'react'
import { Layout, BarChart3, Shield, Activity, Settings, Search, ArrowUpRight } from 'lucide-react'
import { fetchStats, fetchRules, fetchAuditLogs } from './lib/api'

function App() {
  const [activeTab, setActiveTab] = useState('dashboard')
  const [stats, setStats] = useState<any>(null)
  const [rules, setRules] = useState<any[]>([])
  const [logs, setLogs] = useState<any[]>([])

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

  return (
    <div className="app-container">
      <header>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Shield size={24} color="#fff" />
          <h3 style={{ margin: 0, letterSpacing: '-0.02em' }}>ConsentGuard</h3>
          <span className="badge badge-success" style={{ marginLeft: '8px', fontSize: '10px' }}>Beta</span>
        </div>
        <nav className="nav-links">
          <a href="#" onClick={() => setActiveTab('dashboard')} className={`nav-link ${activeTab === 'dashboard' ? 'active' : ''}`}>Dashboard</a>
          <a href="#" onClick={() => setActiveTab('rules')} className={`nav-link ${activeTab === 'rules' ? 'active' : ''}`}>Rules</a>
          <a href="#" onClick={() => setActiveTab('audit')} className={`nav-link ${activeTab === 'audit' ? 'active' : ''}`}>Audit Log</a>
        </nav>
      </header>

      <main>
        {activeTab === 'dashboard' && (
          <div className="fade-in">
            <div style={{ marginBottom: '32px' }}>
              <h1 style={{ marginBottom: '8px' }}>Overview</h1>
              <p>Real-time monitoring of your privacy enforcement layer.</p>
            </div>

            <div className="stats-grid">
              <div className="card">
                <h3>Forwarded</h3>
                <div className="stat-value" style={{ color: '#0070f3' }}>
                  {stats?.forwarded || 0}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginTop: '8px', fontSize: '12px' }}>
                  <ArrowUpRight size={14} /> <span>12% from last hour</span>
                </div>
              </div>
              <div className="card">
                <h3>Blocked</h3>
                <div className="stat-value" style={{ color: '#ee0000' }}>
                  {stats?.blocked || 0}
                </div>
                <p style={{ marginTop: '8px', fontSize: '12px' }}>Prevented non-compliant data leaks</p>
              </div>
              <div className="card">
                <h3>Errors</h3>
                <div className="stat-value">
                  {stats?.errors || 0}
                </div>
                <p style={{ marginTop: '8px', fontSize: '12px' }}>Upstream connection issues</p>
              </div>
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
                    <tr key={i}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{log.userId}</td>
                      <td>{log.destination}</td>
                      <td>
                        <span className={`badge ${log.decision === 'blocked' ? 'badge-error' : 'badge-success'}`}>
                          {log.decision}
                        </span>
                      </td>
                      <td style={{ color: 'var(--accents-5)' }}>{log.reason}</td>
                      <td style={{ color: 'var(--accents-4)', fontSize: '12px' }}>{new Date(log.timestamp).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'rules' && (
          <div className="fade-in">
             <div style={{ marginBottom: '32px', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
              <div>
                <h1 style={{ marginBottom: '8px' }}>Destination Rules</h1>
                <p>Manage how ConsentGuard transforms data for each provider.</p>
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
                      <td><span className="badge badge-secondary">{rule.category}</span></td>
                      <td>
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {rule.transformations.map((t: any, i: number) => (
                            <span key={i} style={{ fontSize: '10px', background: '#111', padding: '2px 6px', borderRadius: '4px', border: '1px solid #333' }}>
                              {t.action}:{t.path}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td>
                        <button className="btn btn-secondary" style={{ padding: '4px 12px' }}>Edit</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default App

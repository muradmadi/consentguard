import { Activity, Shield, ShieldOff } from 'lucide-react'

export function LiveTraffic({ logs }: { logs: any[] }) {
  // Newest first; the API already returns the log in reverse-chronological order.
  const stream = logs.slice(0, 15)

  return (
    <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
      <div
        style={{
          padding: '16px 20px',
          borderBottom: '1px solid #333',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <Activity size={16} className="text-blue" />
        <h3 style={{ margin: 0, fontSize: '14px' }}>Live Enforcement Stream</h3>
      </div>
      <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
        {stream.length === 0 ? (
          <div style={{ padding: '40px', textAlign: 'center', color: 'var(--accents-4)' }}>
            No traffic detected yet...
          </div>
        ) : (
          stream.map((log, i) => (
            <div
              key={i}
              style={{
                padding: '12px 20px',
                borderBottom: '1px solid #111',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                animation: 'fade-in 0.3s ease',
              }}
            >
              {log.decision === 'blocked' ? (
                <ShieldOff size={18} color="#ee0000" />
              ) : (
                <Shield size={18} color="#0070f3" />
              )}
              <div style={{ flex: 1 }}>
                <div
                  style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                >
                  <span style={{ fontWeight: 600, fontSize: '13px' }}>{log.destination}</span>
                  <span style={{ fontSize: '11px', color: 'var(--accents-4)' }}>
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour12: false,
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--accents-5)', marginTop: '2px' }}>
                  {log.decision === 'scrubbed' ? 'PII Scrubbed' : log.decision.toUpperCase()} •{' '}
                  {log.userId.slice(0, 8)}...
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      <div
        style={{
          padding: '8px 20px',
          background: '#111',
          fontSize: '11px',
          color: 'var(--accents-4)',
          textAlign: 'right',
        }}
      >
        Auto-refreshing every 5s
      </div>
    </div>
  )
}

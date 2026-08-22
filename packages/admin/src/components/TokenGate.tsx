import { useState } from 'react'
import { Shield } from 'lucide-react'

interface TokenGateProps {
  error: string
  onSubmit: (token: string) => void
}

/**
 * Ask the operator for the admin bearer.
 *
 * The dashboard is served unauthenticated, so this is the only place the token
 * exists in the browser. It is never written into the bundle and never leaves
 * this tab's session storage.
 */
export function TokenGate({ error, onSubmit }: TokenGateProps) {
  const [token, setToken] = useState('')

  return (
    <div className="app-container">
      <main style={{ maxWidth: '420px', margin: '15vh auto' }}>
        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
            <Shield size={20} />
            <h3 style={{ margin: 0 }}>Sluice</h3>
          </div>
          <p style={{ fontSize: '13px', color: 'var(--accents-4)' }}>
            Enter the proxy&rsquo;s <code>ADMIN_SECRET</code> to read the audit log and edit rules.
            It is kept in this tab only, until you close it.
          </p>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (token.trim()) onSubmit(token.trim())
            }}
          >
            <div className="form-group" style={{ marginTop: '16px' }}>
              <label htmlFor="admin-token">Admin token</label>
              <input
                id="admin-token"
                type="password"
                autoFocus
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>

            {error && (
              <p style={{ fontSize: '12px', color: '#ee0000', marginTop: '8px' }}>{error}</p>
            )}

            <button type="submit" className="btn" style={{ marginTop: '16px', width: '100%' }}>
              Unlock
            </button>
          </form>
        </div>
      </main>
    </div>
  )
}

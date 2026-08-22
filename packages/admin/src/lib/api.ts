import { getToken } from './auth'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000'

/** The proxy rejected the token we sent. The caller re-prompts for it. */
export class UnauthorizedError extends Error {
  constructor() {
    super('The proxy rejected this admin token.')
    this.name = 'UnauthorizedError'
  }
}

/**
 * Every admin call carries the token the operator entered this session. It is
 * read at call time rather than captured at module load, so signing in works
 * without a reload.
 */
async function request(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${getToken()}` },
  })
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

export function fetchStats() {
  return request('/api/stats')
}

export function fetchRules() {
  return request('/api/rules')
}

export function updateRule(id: string, rule: any) {
  return request(`/api/rules/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(rule),
  })
}

export function fetchAuditLogs() {
  return request('/audit')
}

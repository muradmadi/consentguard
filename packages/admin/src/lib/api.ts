import type { AuditPage, ChainStatus, RuleHealthReport } from '@sluice/shared'
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
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${getToken()}` },
  })
  if (res.status === 401 || res.status === 403) throw new UnauthorizedError()
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res
}

async function request(path: string, init: RequestInit = {}) {
  return (await send(path, init)).json()
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

/**
 * What the proxy has actually measured about itself.
 *
 * The dashboard used to print "System Healthy" and "Redis: Connected" as
 * literals. Everything under this endpoint is a probe result or a count taken
 * from the sink, which is the only thing the operator surface is entitled to
 * state as fact.
 */
export function fetchHealth() {
  return request('/api/health')
}

/** The server's own page ceiling; an export asks for as much as it will give. */
const EXPORT_LIMIT = 10000

export interface AuditFilters {
  from?: string
  to?: string
  destination?: string
  decision?: string
  detector?: string
  userId?: string
  limit?: number
  cursor?: number
}

function toQuery(filters: AuditFilters): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

export function fetchAudit(filters: AuditFilters = {}): Promise<AuditPage> {
  return request(`/audit${toQuery(filters)}`) as Promise<AuditPage>
}

export function verifyAudit(): Promise<ChainStatus> {
  return request('/audit/verify') as Promise<ChainStatus>
}

export function fetchRuleHealth(): Promise<RuleHealthReport> {
  return request('/api/rule-health') as Promise<RuleHealthReport>
}

/**
 * Save the current filter's records as a file.
 *
 * The export needs the bearer, so it cannot be a plain link — the response is
 * fetched with the header and handed to the browser as a blob.
 */
export async function downloadAudit(
  format: 'csv' | 'ndjson',
  filters: AuditFilters = {},
): Promise<void> {
  const params = new URLSearchParams(
    toQuery({ ...filters, limit: filters.limit ?? EXPORT_LIMIT }).slice(1),
  )
  params.set('format', format)
  const res = await send(`/audit?${params.toString()}`)
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `sluice-audit.${format}`
  link.click()
  URL.revokeObjectURL(url)
}

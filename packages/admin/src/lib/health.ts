import type { ChainStatus } from '@sluice/shared'

/**
 * What `/api/health` reports. Every field is something the proxy measured: a
 * storage round trip, a count of what the sink holds, the chain head it would
 * verify against. The dashboard renders these and invents nothing.
 */
export interface Health {
  status: 'ok' | 'degraded'
  storage: { kind: string; ok: boolean; latencyMs: number; error: string | null }
  audit: {
    configured: boolean
    kind: string
    healthy: boolean
    location: string | null
    entries: number
    oldest: string | null
    newest: string | null
    retentionDays: number | null
    head: { seq: number; hash: string } | null
    lastError: string | null
    cacheEntries: number
    required: boolean
    evidenceAvailable: boolean
  }
  detectors: string[]
  uptimeSeconds: number
}

export type { ChainStatus }

/** A hash is 64 hex characters; an operator recognises it by its first few. */
export function shortHash(hash: string | undefined | null): string {
  return hash ? hash.slice(0, 12) : '—'
}

export function chainLabel(chain: ChainStatus | null): { text: string; ok: boolean } {
  if (!chain) return { text: 'Chain: not checked', ok: true }
  switch (chain.status) {
    case 'intact':
      return { text: `Chain intact (${chain.checked} records)`, ok: true }
    case 'truncated':
      return { text: `Chain intact from seq ${chain.head ? chain.head.seq : '?'}`, ok: true }
    case 'broken':
      return { text: `Chain broken at seq ${chain.brokenAt}`, ok: false }
    case 'unavailable':
      return { text: 'No durable record to verify', ok: false }
    default:
      return { text: 'Chain unverified', ok: false }
  }
}

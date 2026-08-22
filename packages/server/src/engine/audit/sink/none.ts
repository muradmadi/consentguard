import type { AuditPage, ChainStatus } from '@sluice/shared'
import type { ChainHead } from '../chain'
import type { AuditSink, SinkStatus } from './types'

/**
 * No durable sink. The audit is whatever the display cache still holds, which
 * rolls over.
 *
 * This reports `configured: false` rather than pretending to be healthy or
 * broken, and it never blocks: the fail-closed gate exists for a sink that has
 * been set up and is failing, not for an operator who has deliberately turned
 * the sink off or is running somewhere without a filesystem.
 */
export class NullAuditSink implements AuditSink {
  readonly kind = 'none'
  readonly configured = false

  async init(): Promise<void> {}

  async append(): Promise<void> {}

  async query(): Promise<AuditPage> {
    return { records: [], nextCursor: null, scanned: 0 }
  }

  async verify(): Promise<ChainStatus> {
    return {
      status: 'unavailable',
      checked: 0,
      head: null,
      reason: 'no durable audit sink is configured',
    }
  }

  async status(): Promise<SinkStatus> {
    return {
      configured: false,
      kind: this.kind,
      healthy: true,
      location: null,
      entries: 0,
      oldest: null,
      newest: null,
      retentionDays: null,
      head: null,
      lastError: null,
    }
  }

  head(): ChainHead | null {
    return null
  }

  healthy(): boolean {
    return true
  }
}

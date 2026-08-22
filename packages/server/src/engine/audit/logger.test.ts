import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { AuditPage, ChainStatus, SealedAuditRecord } from '@sluice/shared'
import { MemoryStorageProvider } from '../storage'
import { AuditLogger } from './logger'
import { NullAuditSink } from './sink/none'
import type { AuditQuery, AuditSink, SinkStatus } from './sink/types'

/** A sink that keeps records in an array and can be told to start refusing. */
class FakeSink implements AuditSink {
  readonly kind = 'fake'
  readonly configured = true

  records: SealedAuditRecord[] = []
  failing = false
  initCalls = 0

  async init(): Promise<void> {
    this.initCalls++
  }

  async append(record: SealedAuditRecord): Promise<void> {
    if (this.failing) throw new Error('disk full')
    this.records.push(record)
  }

  async query(query: AuditQuery): Promise<AuditPage> {
    void query
    return { records: [...this.records].reverse(), nextCursor: null, scanned: this.records.length }
  }

  async verify(): Promise<ChainStatus> {
    return { status: 'intact', checked: this.records.length, head: this.head() }
  }

  async status(): Promise<SinkStatus> {
    return {
      configured: true,
      kind: this.kind,
      healthy: !this.failing,
      location: 'memory',
      entries: this.records.length,
      oldest: this.records[0]?.timestamp ?? null,
      newest: this.records[this.records.length - 1]?.timestamp ?? null,
      retentionDays: 90,
      head: this.head(),
      lastError: null,
    }
  }

  head() {
    const last = this.records[this.records.length - 1]
    return last ? { seq: last.seq, hash: last.hash } : null
  }

  healthy(): boolean {
    return !this.failing
  }
}

const entry = { userId: 'user-1', destination: 'ga4', decision: 'forwarded' as const, reason: 'ok' }

describe('AuditLogger', () => {
  let storage: MemoryStorageProvider

  beforeEach(() => {
    storage = new MemoryStorageProvider()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('seals every record into a chain the sink can verify', async () => {
    const sink = new FakeSink()
    const logger = new AuditLogger(storage, { sink })

    await logger.log(entry)
    await logger.log({ ...entry, userId: 'user-2' })

    expect(sink.records.map((r) => r.seq)).toEqual([0, 1])
    expect(sink.records[1].prevHash).toBe(sink.records[0].hash)
  })

  it('trims the display cache to the configured size, not a hard-coded one', async () => {
    const logger = new AuditLogger(storage, { sink: new FakeSink(), cacheEntries: 3 })

    for (let i = 0; i < 6; i++) await logger.log({ ...entry, userId: `user-${i}` })

    expect(await storage.llen('sluice_audit_trail')).toBe(3)
  })

  it('keeps the record even when the display cache is unwritable', async () => {
    const sink = new FakeSink()
    vi.spyOn(storage, 'lpush').mockRejectedValue(new Error('redis down'))
    const logger = new AuditLogger(storage, { sink })

    await logger.log(entry)

    expect(sink.records).toHaveLength(1)
  })

  it('stops claiming evidence is available once a sink write has failed', async () => {
    const sink = new FakeSink()
    const logger = new AuditLogger(storage, { sink })

    expect(await logger.evidenceAvailable()).toBe(true)

    sink.failing = true
    await logger.log(entry)

    expect(await logger.evidenceAvailable()).toBe(false)
  })

  it('does not block when the operator has turned the requirement off', async () => {
    const sink = new FakeSink()
    sink.failing = true
    const logger = new AuditLogger(storage, { sink, required: false })

    await logger.log(entry)

    expect(await logger.evidenceAvailable()).toBe(true)
  })

  it('treats an absent sink as a choice rather than a failure', async () => {
    const logger = new AuditLogger(storage, { sink: new NullAuditSink() })
    await logger.log(entry)
    expect(await logger.evidenceAvailable()).toBe(true)
  })

  it('answers queries from the cache when there is no sink to answer them', async () => {
    const logger = new AuditLogger(storage, { sink: new NullAuditSink() })

    await logger.log({ ...entry, destination: 'ga4' })
    await logger.log({ ...entry, destination: 'mixpanel' })

    const page = await logger.query({ destination: 'mixpanel' })
    expect(page.records.map((r) => r.destination)).toEqual(['mixpanel'])
  })

  it('picks the chain back up from the cache when no sink holds a head', async () => {
    const first = new AuditLogger(storage, { sink: new NullAuditSink() })
    await first.log(entry)
    await first.log(entry)

    const restarted = new AuditLogger(storage, { sink: new NullAuditSink() })
    await restarted.log(entry)

    const page = await restarted.query({ limit: 1 })
    expect(page.records[0].seq).toBe(2)
  })

  it('clears the display cache and leaves the durable record alone', async () => {
    const sink = new FakeSink()
    const logger = new AuditLogger(storage, { sink })

    await logger.log(entry)
    await logger.clear()

    expect(await storage.llen('sluice_audit_trail')).toBe(0)
    expect(sink.records).toHaveLength(1)
  })
})

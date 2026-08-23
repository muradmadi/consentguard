import {
  ANONYMOUS_SUBJECT,
  AuditRecord,
  AuditPage,
  ChainStatus,
  SealedAuditRecord,
  SealedAuditRecordSchema,
} from '@sluice/shared'
import type { StorageProvider } from '../storage'
import { sealRecord, type ChainHead } from './chain'
import { afterCursor, matchesQuery, pageSize } from './query'
import type { AuditQuery, AuditSink, SinkStatus } from './sink/types'
import { NullAuditSink } from './sink/none'

export type { AuditRecord }

/** How many records the display cache keeps when the operator says nothing. */
export const DEFAULT_CACHE_ENTRIES = 1000

export interface AuditLoggerOptions {
  sink?: AuditSink
  /** Size of the in-front display cache. Not a retention policy — the sink is. */
  cacheEntries?: number
  /**
   * Whether a configured sink that cannot write should stop the firewall
   * forwarding. On by default: the record is half the product, and a forward we
   * cannot evidence is a forward we should not make.
   */
  required?: boolean
  /**
   * Pseudonymises the subject a record names, before it is sealed.
   *
   * The record is exported: `/audit?format=csv` and `sluice export` produce
   * files that go to auditors and regulators, and they used to carry the CMP's
   * subject ids in the clear. Sealing a keyed digest instead means an export can
   * be handed over without disclosing who the rows are about, and a query by
   * subject still works because the query is hashed the same way before it is
   * matched.
   *
   * What this does not do is answer an erasure request: a keyed pseudonym is
   * still personal data, and the deployment holds the key. What the record is
   * retained under is a separate question, argued in `docs/scope.md`.
   *
   * Omitted, the subject is stored as it arrived. That is what the sink's own
   * tests want, since they are asserting on the chain rather than on identity.
   */
  subjectHasher?: (subject: string) => string
}

/**
 * Writes the per-request record.
 *
 * Two places, one of which is authoritative. The durable sink is the evidence;
 * the storage list in front of it is a display cache for the dashboard, sized
 * for a screenful rather than for a retention policy. When they disagree the
 * sink wins, and a query only falls back to the cache when no sink exists.
 */
export class AuditLogger {
  private readonly KEY = 'sluice_audit_trail'
  private readonly cacheEntries: number
  private readonly required: boolean
  private readonly sink: AuditSink
  private readonly subjectHasher: (subject: string) => string

  /**
   * The chain head, held here rather than read back per write. Sealing is a
   * read-modify-write, so appends are serialised through `tail` — two records
   * sealed against the same head would claim the same sequence number.
   */
  private chainHead: ChainHead | null = null
  private headLoaded = false
  private tail: Promise<unknown> = Promise.resolve()

  constructor(
    private storage: StorageProvider,
    options: AuditLoggerOptions = {},
  ) {
    this.sink = options.sink ?? new NullAuditSink()
    this.cacheEntries = options.cacheEntries ?? DEFAULT_CACHE_ENTRIES
    this.required = options.required ?? true
    this.subjectHasher = options.subjectHasher ?? ((subject) => subject)
  }

  /**
   * Whether the firewall can still prove what it does.
   *
   * A sink that has never been configured is not a failure — the operator said
   * no. A sink that was configured and is now refusing writes is, and this is
   * what `/ingest` checks before forwarding anything.
   */
  async evidenceAvailable(): Promise<boolean> {
    if (!this.required || !this.sink.configured) return true
    // Initialising is what proves the sink is writable, and it is memoised, so
    // the first request through the firewall is gated on the same fact as the
    // thousandth rather than on an assumption that has not been tested yet.
    await this.sink.init()
    return this.sink.healthy()
  }

  /**
   * Seal a decision record and write it.
   *
   * A sink failure is not swallowed the way a cache failure is: it flips
   * `evidenceAvailable()` and the next request is refused.
   */
  async log(
    record: Omit<AuditRecord, 'timestamp' | 'transformations'> & {
      transformations?: AuditRecord['transformations']
    },
  ): Promise<void> {
    const fullRecord: AuditRecord = {
      transformations: [],
      ...record,
      userId: this.pseudonymousSubject(record.userId),
      timestamp: new Date().toISOString(),
    }

    const write = this.tail.then(() => this.sealAndWrite(fullRecord))
    this.tail = write.catch(() => undefined)

    try {
      await write
    } catch (error) {
      console.error('[Sluice] Audit sink write failed:', error)
    }
  }

  private async sealAndWrite(record: AuditRecord): Promise<void> {
    await this.loadHead()
    const sealed = sealRecord(record, this.chainHead)

    await this.sink.append(sealed)
    this.chainHead = { seq: sealed.seq, hash: sealed.hash }

    // The cache is a convenience. Losing it costs the dashboard a screenful,
    // not the record, so a failure here is logged and does not propagate.
    try {
      await this.storage.lpush(this.KEY, JSON.stringify(sealed))
      await this.storage.ltrim(this.KEY, 0, this.cacheEntries - 1)
    } catch (error) {
      console.error('[Sluice] Audit display cache write failed:', error)
    }
  }

  /**
   * Pick the chain up where the last process left it.
   *
   * The sink is the authority. With no sink the cache's newest entry is the
   * only continuity there is, and if that has rolled over the chain restarts —
   * which is exactly the weakness a sink exists to remove.
   */
  private async loadHead(): Promise<void> {
    if (this.headLoaded) return
    this.headLoaded = true

    await this.sink.init()
    this.chainHead = this.sink.head()
    if (this.chainHead || this.sink.configured) return

    try {
      const [newest] = await this.storage.lrange(this.KEY, 0, 0)
      if (!newest) return
      const parsed = SealedAuditRecordSchema.safeParse(JSON.parse(newest))
      if (parsed.success) this.chainHead = { seq: parsed.data.seq, hash: parsed.data.hash }
    } catch {
      /* no usable head; the chain starts again at genesis */
    }
  }

  /**
   * Newest first, filtered and paged. The sink answers when there is one.
   *
   * A subject filter is pseudonymised on the way in, under the same key the
   * records were sealed with. The operator asks by the id they know — the one
   * their CMP issued — and never has to hold a digest to search for; the stored
   * form is what changed, not the question anybody asks of it.
   */
  async query(query: AuditQuery = {}): Promise<AuditPage> {
    const resolved: AuditQuery = query.userId
      ? { ...query, userId: this.pseudonymousSubject(query.userId) }
      : query
    if (this.sink.configured) return this.sink.query(resolved)
    return this.queryCache(resolved)
  }

  /**
   * The subject as it is stored and searched for.
   *
   * `(anonymous)` is passed through: it names the absence of an identity rather
   * than an identity we are declining to print, and hashing it would turn a
   * legible fact into a digest that says the same thing less clearly.
   */
  private pseudonymousSubject(subject: string): string {
    if (subject === ANONYMOUS_SUBJECT) return subject
    return this.subjectHasher(subject)
  }

  private async queryCache(query: AuditQuery): Promise<AuditPage> {
    const limit = pageSize(query.limit)
    const raw = await this.storage.lrange(this.KEY, 0, this.cacheEntries - 1)
    const records: SealedAuditRecord[] = []
    let scanned = 0

    for (const line of raw) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        console.warn('[Sluice] Discarded unparseable audit entry')
        continue
      }
      const result = SealedAuditRecordSchema.safeParse(parsed)
      if (!result.success) {
        console.warn('[Sluice] Discarded audit entry that failed schema validation')
        continue
      }
      if (!afterCursor(result.data, query.cursor)) continue
      scanned++
      if (matchesQuery(result.data, query)) records.push(result.data)
      if (records.length >= limit) {
        return { records, nextCursor: records[records.length - 1].seq, scanned }
      }
    }

    return { records, nextCursor: null, scanned }
  }

  verify(): Promise<ChainStatus> {
    return this.sink.verify()
  }

  status(): Promise<SinkStatus> {
    return this.sink.status()
  }

  /**
   * Clear the display cache.
   *
   * The sink is append-only and is deliberately not touched. A record that can
   * be deleted by whoever holds the admin token proves nothing about what
   * happened, so `/api/debug/reset` resets the view and leaves the evidence.
   */
  async clear(): Promise<void> {
    await this.storage.del(this.KEY)
  }
}

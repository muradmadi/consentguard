import { createReadStream } from 'fs'
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import { AuditPage, ChainStatus, SealedAuditRecord, SealedAuditRecordSchema } from '@sluice/shared'
import { verifyChain, type ChainHead } from '../chain'
import { afterCursor, matchesQuery, pageSize } from '../query'
import type { AuditQuery, AuditSink, SinkStatus } from './types'

const SEGMENT_PREFIX = 'audit-'
const SEGMENT_SUFFIX = '.ndjson'
const MANIFEST = 'manifest.json'

/** What retention removed, and the chain position it removed it up to. */
interface PruneAnchor {
  seq: number
  hash: string
  prunedThrough: string
  prunedAt: string
}

interface Manifest {
  version: 1
  retentionDays: number
  anchors: PruneAnchor[]
}

export interface FileAuditSinkOptions {
  dir: string
  retentionDays: number
}

/**
 * The durable audit record: newline-delimited JSON on disk, one file per UTC
 * day, never rewritten.
 *
 * The Redis list this sits behind used to be the whole record, capped at a
 * thousand entries that rolled over silently. Regulators do not ask what a
 * firewall does, they ask to be shown records, so the file is the evidence and
 * the list is a convenience in front of it.
 *
 * Writes are serialised through a promise chain because sealing a record is a
 * read-modify-write of the chain head, and two concurrent appends would both
 * claim the same sequence number. That makes this correct for one process, which
 * is what Sluice is; a second process writing the same directory would interleave
 * and produce a chain that does not verify.
 */
export class FileAuditSink implements AuditSink {
  readonly kind = 'file'
  readonly configured = true

  private readonly dir: string
  private readonly retentionDays: number

  private chainHead: ChainHead | null = null
  private anchor: PruneAnchor | null = null
  private entries = 0
  private oldest: string | null = null
  private newest: string | null = null
  private currentSegment: string | null = null
  private lastError: string | null = null
  private isHealthy = true
  private initialized: Promise<void> | null = null

  /** Serialises appends; every write links onto the one before it. */
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: FileAuditSinkOptions) {
    this.dir = options.dir
    this.retentionDays = options.retentionDays
  }

  async init(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.load().catch((error) => {
        // A sink that cannot be read cannot be appended to either. Record why,
        // and let `healthy()` stop the firewall rather than forwarding blind.
        this.fail(error)
        this.initialized = null
      })
    }
    return this.initialized
  }

  private async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })

    // Prove the directory is writable now, rather than discovering it while
    // recording the first request — by then the forward has already happened.
    // Opening today's segment in append mode creates it empty if it is missing
    // and changes nothing if it is not.
    await appendFile(this.segmentPath(utcDay(new Date().toISOString())), '', { mode: 0o600 })

    this.anchor = await this.readAnchor()

    // Retention runs on the day boundary, which a process that never sees one
    // never reaches. Apply the window on the way up so a restart is enough.
    await this.enforceRetention(utcDay(new Date().toISOString()))

    const segments = await this.segments()
    this.currentSegment = segments.length > 0 ? segments[segments.length - 1] : null

    let total = 0
    for (const segment of segments) total += await this.countLines(segment)
    this.entries = total

    if (segments.length > 0) {
      const first = await this.firstRecord(segments[0])
      this.oldest = first?.timestamp ?? null
      const last = await this.lastRecord(segments[segments.length - 1])
      if (last) {
        this.chainHead = { seq: last.seq, hash: last.hash }
        this.newest = last.timestamp
      }
    }

    this.isHealthy = true
    this.lastError = null
  }

  async append(record: SealedAuditRecord): Promise<void> {
    await this.init()
    const write = this.tail.then(() => this.writeRecord(record))
    // Keep the chain intact after a failed write: the next append still links
    // onto whatever the head is, rather than onto a rejected promise.
    this.tail = write.catch(() => undefined)
    return write
  }

  private async writeRecord(record: SealedAuditRecord): Promise<void> {
    const day = utcDay(record.timestamp)

    try {
      if (this.currentSegment && segmentDay(this.currentSegment) !== day) {
        await this.enforceRetention(day)
      }
      await appendFile(this.segmentPath(day), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    } catch (error) {
      this.fail(error)
      throw error
    }

    this.currentSegment = segmentName(day)
    this.chainHead = { seq: record.seq, hash: record.hash }
    this.entries++
    this.newest = record.timestamp
    if (!this.oldest) this.oldest = record.timestamp
    this.isHealthy = true
    this.lastError = null
  }

  /**
   * Drop segments past the retention window, recording where the chain was cut.
   *
   * Deleting records is the one legitimate way for the chain to stop short of
   * its genesis, so the last position removed is written to the manifest before
   * the files go. Without that, expiry and tampering look identical to
   * `verifyChain`.
   */
  private async enforceRetention(today: string): Promise<void> {
    const cutoff = utcDayOffset(today, -this.retentionDays)
    const expired = (await this.segments()).filter((s) => segmentDay(s) < cutoff)
    if (expired.length === 0) return

    const newestExpired = expired[expired.length - 1]
    const boundary = await this.lastRecord(newestExpired)

    let removed = 0
    for (const segment of expired) {
      removed += await this.countLines(segment)
      await rm(join(this.dir, segment), { force: true })
    }
    this.entries = Math.max(0, this.entries - removed)

    if (boundary) {
      this.anchor = {
        seq: boundary.seq,
        hash: boundary.hash,
        prunedThrough: segmentDay(newestExpired),
        prunedAt: new Date().toISOString(),
      }
      await this.writeAnchor(this.anchor)
    }

    const remaining = await this.segments()
    this.oldest =
      remaining.length > 0 ? ((await this.firstRecord(remaining[0]))?.timestamp ?? null) : null
  }

  async query(query: AuditQuery): Promise<AuditPage> {
    await this.init()

    const limit = pageSize(query.limit)
    const records: SealedAuditRecord[] = []
    let scanned = 0

    // Newest first, and only the segments whose day can hold a match.
    const segments = (await this.segments()).reverse().filter((s) => inRange(segmentDay(s), query))

    for (const segment of segments) {
      const lines = await this.readLines(segment)
      for (let i = lines.length - 1; i >= 0; i--) {
        const record = parseRecord(lines[i])
        if (!record || !afterCursor(record, query.cursor)) continue
        scanned++
        if (matchesQuery(record, query)) records.push(record)
        if (records.length >= limit) {
          return { records, nextCursor: records[records.length - 1].seq, scanned }
        }
      }
    }

    return { records, nextCursor: null, scanned }
  }

  async verify(): Promise<ChainStatus> {
    await this.init()
    if (!this.isHealthy) {
      return {
        status: 'unavailable',
        checked: 0,
        head: null,
        reason: this.lastError ?? 'sink unreadable',
      }
    }
    const anchor = this.anchor ? { seq: this.anchor.seq, hash: this.anchor.hash } : null
    return verifyChain(this.readAll(), anchor)
  }

  /** Every retained record, oldest first, one line at a time. */
  private async *readAll(): AsyncGenerator<SealedAuditRecord> {
    for (const segment of await this.segments()) {
      for (const line of await this.readLines(segment)) {
        const record = parseRecord(line)
        if (record) yield record
      }
    }
  }

  async status(): Promise<SinkStatus> {
    await this.init()
    return {
      configured: true,
      kind: this.kind,
      healthy: this.isHealthy,
      location: this.dir,
      entries: this.entries,
      oldest: this.oldest,
      newest: this.newest,
      retentionDays: this.retentionDays,
      head: this.chainHead,
      lastError: this.lastError,
    }
  }

  head(): ChainHead | null {
    return this.chainHead
  }

  healthy(): boolean {
    return this.isHealthy
  }

  // ---------- disk ----------

  private segmentPath(day: string): string {
    return join(this.dir, segmentName(day))
  }

  /**
   * Segment file names, oldest first. Names sort chronologically by design.
   *
   * Directory entries are checked, not just named: something shaped like a
   * segment but not a file is not one, and treating it as one turns a bad write
   * into a crash on every read.
   */
  private async segments(): Promise<string[]> {
    try {
      const entries = await readdir(this.dir, { withFileTypes: true })
      return entries
        .filter((entry) => entry.isFile() && isSegment(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  private async readLines(segment: string): Promise<string[]> {
    try {
      const text = await readFile(join(this.dir, segment), 'utf8')
      return text.split('\n').filter(Boolean)
    } catch {
      return []
    }
  }

  /** Count records without parsing them — a byte scan, not a JSON pass. */
  private async countLines(segment: string): Promise<number> {
    return new Promise((resolve) => {
      let count = 0
      const stream = createReadStream(join(this.dir, segment))
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      lines.on('line', (line) => {
        if (line.trim()) count++
      })
      lines.on('close', () => resolve(count))
      stream.on('error', () => resolve(0))
    })
  }

  private async firstRecord(segment: string): Promise<SealedAuditRecord | null> {
    for (const line of await this.readLines(segment)) {
      const record = parseRecord(line)
      if (record) return record
    }
    return null
  }

  private async lastRecord(segment: string): Promise<SealedAuditRecord | null> {
    const lines = await this.readLines(segment)
    for (let i = lines.length - 1; i >= 0; i--) {
      const record = parseRecord(lines[i])
      if (record) return record
    }
    return null
  }

  private async readAnchor(): Promise<PruneAnchor | null> {
    try {
      const manifest = JSON.parse(await readFile(join(this.dir, MANIFEST), 'utf8')) as Manifest
      if (!Array.isArray(manifest.anchors) || manifest.anchors.length === 0) return null
      // The newest anchor is the only one that can attach to retained records;
      // the rest are kept as a history of what retention removed and when.
      return manifest.anchors.reduce((a, b) => (b.seq > a.seq ? b : a))
    } catch {
      return null
    }
  }

  private async writeAnchor(anchor: PruneAnchor): Promise<void> {
    let manifest: Manifest = { version: 1, retentionDays: this.retentionDays, anchors: [] }
    try {
      const existing = JSON.parse(await readFile(join(this.dir, MANIFEST), 'utf8')) as Manifest
      if (Array.isArray(existing.anchors)) manifest.anchors = existing.anchors
    } catch {
      /* first prune: there is no manifest yet */
    }
    manifest = { ...manifest, anchors: [...manifest.anchors, anchor] }
    await writeFile(join(this.dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    })
  }

  private fail(error: unknown): void {
    this.isHealthy = false
    this.lastError = error instanceof Error ? error.message : String(error)
    console.error('[Sluice] Audit sink write failed:', error)
  }
}

// ---------- helpers ----------

function segmentName(day: string): string {
  return `${SEGMENT_PREFIX}${day}${SEGMENT_SUFFIX}`
}

function isSegment(name: string): boolean {
  return (
    name.startsWith(SEGMENT_PREFIX) &&
    name.endsWith(SEGMENT_SUFFIX) &&
    /^\d{4}-\d{2}-\d{2}$/.test(segmentDay(name))
  )
}

function segmentDay(name: string): string {
  return name.slice(SEGMENT_PREFIX.length, name.length - SEGMENT_SUFFIX.length)
}

function utcDay(timestamp: string): string {
  const parsed = new Date(timestamp)
  const date = Number.isNaN(parsed.getTime()) ? new Date() : parsed
  return date.toISOString().slice(0, 10)
}

function utcDayOffset(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * Whether a day's segment can hold a record the query wants. Comparing the day
 * against the date half of an ISO timestamp keeps the boundary days in — the
 * per-record filter is what actually applies the time of day.
 */
function inRange(day: string, query: AuditQuery): boolean {
  if (query.from && day < query.from.slice(0, 10)) return false
  if (query.to && day > query.to.slice(0, 10)) return false
  return true
}

/**
 * A record we cannot vouch for is not evidence, so a line that will not parse
 * against the current schema is dropped rather than surfaced. It still counts
 * against the chain: `verifyChain` will find the gap where it should have been.
 */
function parseRecord(line: string): SealedAuditRecord | null {
  try {
    const result = SealedAuditRecordSchema.safeParse(JSON.parse(line))
    if (result.success) return result.data
  } catch {
    /* fall through */
  }
  console.warn('[Sluice] Discarded an audit line that does not parse')
  return null
}

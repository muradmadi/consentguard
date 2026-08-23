import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFile, chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AuditRecord, SealedAuditRecord } from '@sluice/shared'
import { sealRecord } from '../chain'
import { FileAuditSink } from './file'

const DAY = 24 * 60 * 60 * 1000

function record(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    timestamp: new Date().toISOString(),
    userId: 'user-1',
    destination: 'ga4',
    decision: 'forwarded',
    reason: 'consent_granted',
    transformations: [],
    ...overrides,
  }
}

describe('FileAuditSink', () => {
  let dir: string

  /** Appends through the sink, sealing each record onto the sink's own head. */
  async function write(
    sink: FileAuditSink,
    overrides: Partial<AuditRecord> = {},
  ): Promise<SealedAuditRecord> {
    await sink.init()
    const sealed = sealRecord(record(overrides), sink.head())
    await sink.append(sealed)
    return sealed
  }

  function daysAgo(days: number): string {
    return new Date(Date.now() - days * DAY).toISOString()
  }

  function todaysSegment(): string {
    return join(dir, `audit-${new Date().toISOString().slice(0, 10)}.ndjson`)
  }

  /**
   * Make the next append fail without depending on file permissions, which a
   * test run as root would ignore.
   */
  async function blockTodaysSegment(): Promise<void> {
    await rm(todaysSegment(), { force: true })
    await mkdir(todaysSegment())
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sluice-audit-'))
  })

  afterEach(async () => {
    await chmod(dir, 0o700).catch(() => undefined)
    await rm(dir, { recursive: true, force: true })
  })

  it('writes one NDJSON line per record into a day segment', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink, { userId: 'a' })
    await write(sink, { userId: 'b' })

    const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/^audit-\d{4}-\d{2}-\d{2}\.ndjson$/)

    const lines = (await readFile(join(dir, files[0]), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).userId).toBe('a')
    expect(JSON.parse(lines[1]).seq).toBe(1)
  })

  it('recovers the chain head after a restart, so sequence numbers do not repeat', async () => {
    const first = new FileAuditSink({ dir, retentionDays: 90 })
    await write(first)
    await write(first)

    const restarted = new FileAuditSink({ dir, retentionDays: 90 })
    await restarted.init()
    expect(restarted.head()?.seq).toBe(1)

    const next = await write(restarted)
    expect(next.seq).toBe(2)
    expect(next.prevHash).toBe(first.head()?.hash)
    expect((await restarted.verify()).status).toBe('intact')
  })

  it('opens a new segment when the day rolls over', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink, { timestamp: daysAgo(1) })
    await write(sink, { timestamp: daysAgo(0) })

    const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
    expect(files).toHaveLength(2)
  })

  it('prunes segments past the retention window and anchors what it removed', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 7 })
    const expired = await write(sink, { timestamp: daysAgo(30), userId: 'old' })
    await write(sink, { timestamp: daysAgo(0), userId: 'new' })

    const files = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
    expect(files).toHaveLength(1)

    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'))
    expect(manifest.anchors).toHaveLength(1)
    expect(manifest.anchors[0]).toMatchObject({ seq: expired.seq, hash: expired.hash })

    const page = await sink.query({})
    expect(page.records.map((r) => r.userId)).toEqual(['new'])
  })

  it('still verifies as intact once retention has cut the chain short', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 7 })
    await write(sink, { timestamp: daysAgo(30) })
    await write(sink, { timestamp: daysAgo(0) })

    expect(await sink.verify()).toMatchObject({ status: 'intact', checked: 1 })
  })

  it('reports a record edited on disk as broken, naming the sequence number', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink, { userId: 'a' })
    const target = await write(sink, { userId: 'b' })

    const [file] = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
    const path = join(dir, file)
    const edited = (await readFile(path, 'utf8')).replace('"userId":"b"', '"userId":"mallory"')
    await writeFile(path, edited)

    const result = await new FileAuditSink({ dir, retentionDays: 90 }).verify()
    expect(result.status).toBe('broken')
    expect(result.brokenAt).toBe(target.seq)
  })

  it('reports a record deleted from the tail as broken', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink)
    await write(sink)
    await write(sink)

    const [file] = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'))
    const path = join(dir, file)
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    await writeFile(path, `${lines[0]}\n${lines[2]}\n`)

    expect((await new FileAuditSink({ dir, retentionDays: 90 }).verify()).status).toBe('broken')
  })

  it('filters by destination, decision, detector and time range', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink, { destination: 'ga4', decision: 'forwarded' })
    await write(sink, { destination: 'mixpanel', decision: 'blocked' })
    await write(sink, {
      destination: 'ga4',
      decision: 'forwarded',
      transformations: [{ path: 'user.email', action: 'hash', matched: 1, detector: 'email' }],
    })

    expect((await sink.query({ destination: 'ga4' })).records).toHaveLength(2)
    expect((await sink.query({ decision: 'blocked' })).records).toHaveLength(1)
    expect((await sink.query({ detector: 'email' })).records).toHaveLength(1)
    expect((await sink.query({ from: new Date(Date.now() + DAY).toISOString() })).records).toEqual(
      [],
    )
  })

  it('pages newest first and resumes below the cursor', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    for (let i = 0; i < 5; i++) await write(sink, { userId: `user-${i}` })

    const first = await sink.query({ limit: 2 })
    expect(first.records.map((r) => r.seq)).toEqual([4, 3])
    expect(first.nextCursor).toBe(3)

    const second = await sink.query({ limit: 2, cursor: first.nextCursor! })
    expect(second.records.map((r) => r.seq)).toEqual([2, 1])

    const last = await sink.query({ limit: 2, cursor: second.nextCursor! })
    expect(last.records.map((r) => r.seq)).toEqual([0])
    expect(last.nextCursor).toBeNull()
  })

  it('pages newest first across day boundaries, not just within one segment', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink, { timestamp: daysAgo(2), userId: 'oldest' })
    await write(sink, { timestamp: daysAgo(1), userId: 'middle' })
    await write(sink, { timestamp: daysAgo(0), userId: 'newest' })

    const all = await sink.query({})
    expect(all.records.map((r) => r.userId)).toEqual(['newest', 'middle', 'oldest'])

    const first = await sink.query({ limit: 2 })
    expect(first.records.map((r) => r.userId)).toEqual(['newest', 'middle'])

    const second = await sink.query({ limit: 2, cursor: first.nextCursor! })
    expect(second.records.map((r) => r.userId)).toEqual(['oldest'])
  })

  it('keeps the records on the boundary days of a range', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    const oldest = await write(sink, { timestamp: daysAgo(2), userId: 'oldest' })
    await write(sink, { timestamp: daysAgo(1), userId: 'middle' })
    await write(sink, { timestamp: daysAgo(0), userId: 'newest' })

    // A range that starts on the oldest record's own timestamp must include it.
    const inclusive = await sink.query({ from: oldest.timestamp })
    expect(inclusive.records.map((r) => r.userId)).toEqual(['newest', 'middle', 'oldest'])

    const upTo = await sink.query({ to: oldest.timestamp })
    expect(upTo.records.map((r) => r.userId)).toEqual(['oldest'])
  })

  it('reports what it holds and how far back', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 30 })
    const oldest = await write(sink, { timestamp: daysAgo(2) })
    const newest = await write(sink, { timestamp: daysAgo(0) })

    expect(await sink.status()).toMatchObject({
      configured: true,
      healthy: true,
      entries: 2,
      oldest: oldest.timestamp,
      newest: newest.timestamp,
      retentionDays: 30,
      head: { seq: newest.seq },
    })
  })

  it('goes unhealthy when it cannot write, so the firewall can stop forwarding', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    await write(sink, { timestamp: daysAgo(1) })
    expect(sink.healthy()).toBe(true)

    await blockTodaysSegment()
    await expect(
      sink.append(sealRecord(record({ userId: 'denied' }), sink.head())),
    ).rejects.toThrow()

    expect(sink.healthy()).toBe(false)
    expect((await sink.status()).lastError).toBeTruthy()
  })

  it('keeps the chain linkable after a failed write', async () => {
    const sink = new FileAuditSink({ dir, retentionDays: 90 })
    const first = await write(sink, { timestamp: daysAgo(1) })

    await blockTodaysSegment()
    await sink.append(sealRecord(record(), sink.head())).catch(() => undefined)
    await rm(todaysSegment(), { recursive: true })

    const next = await write(sink)
    expect(next.prevHash).toBe(first.hash)
    expect(sink.healthy()).toBe(true)
    expect((await sink.verify()).status).toBe('intact')
  })

  /**
   * Appends are serialised in-process, which makes this sink correct for one
   * writer and says nothing about a second. Two containers on one mounted
   * volume each seal against their own head, claim the same sequence numbers,
   * and interleave into a chain that does not verify — silently, until somebody
   * happened to run `sluice verify`.
   *
   * The segment being appended to is now checked against the size this process
   * left it at, so the second writer is caught at the moment it appears and the
   * sink goes unhealthy, which the evidence gate turns into a refusal to
   * forward. `appendFile` from another process is the exact shape of the real
   * failure, so that is what these use.
   */
  describe('a second writer in the same directory', () => {
    it('refuses to append on top of a line it did not write', async () => {
      const sink = new FileAuditSink({ dir, retentionDays: 90 })
      await write(sink)

      // Another process appends its own record, sealed against its own head.
      await appendFile(todaysSegment(), `${JSON.stringify(sealRecord(record(), null))}\n`)

      await expect(write(sink)).rejects.toThrow(/changed underneath this process/)
    })

    it('goes unhealthy, so the evidence gate stops the firewall', async () => {
      const sink = new FileAuditSink({ dir, retentionDays: 90 })
      await write(sink)
      await appendFile(todaysSegment(), `${JSON.stringify(sealRecord(record(), null))}\n`)

      await expect(write(sink)).rejects.toThrow()
      expect(sink.healthy()).toBe(false)
      expect((await sink.status()).lastError).toMatch(/Another writer/)
    })

    it('catches a hand-edited segment as readily as another process', async () => {
      const sink = new FileAuditSink({ dir, retentionDays: 90 })
      await write(sink)

      // Truncating is the shape of somebody removing a record they disliked.
      await writeFile(todaysSegment(), '')

      await expect(write(sink)).rejects.toThrow(/changed underneath this process/)
      expect(sink.healthy()).toBe(false)
    })

    it('writes nothing once it has refused, rather than half a chain', async () => {
      const sink = new FileAuditSink({ dir, retentionDays: 90 })
      await write(sink)
      const foreign = sealRecord(record(), null)
      await appendFile(todaysSegment(), `${JSON.stringify(foreign)}\n`)

      await expect(write(sink)).rejects.toThrow()

      const lines = (await readFile(todaysSegment(), 'utf8')).trim().split('\n')
      expect(lines).toHaveLength(2)
      expect(JSON.parse(lines[1]).hash).toBe(foreign.hash)
    })

    /**
     * A fresh process reads the directory as it finds it, so it adopts the
     * current size as its baseline and appends normally. That is the restart
     * case, and it has to keep working — the check is for concurrent writers,
     * not for a directory that has been written to before.
     */
    it('does not refuse a restart that adopts what is already there', async () => {
      const first = new FileAuditSink({ dir, retentionDays: 90 })
      await write(first)
      await write(first)

      const restarted = new FileAuditSink({ dir, retentionDays: 90 })
      await expect(write(restarted)).resolves.toBeDefined()
      expect(restarted.healthy()).toBe(true)
      expect((await restarted.verify()).status).toBe('intact')
    })
  })
})

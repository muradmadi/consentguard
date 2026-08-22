import { AuditRecord, AuditRecordSchema } from '@sluice/shared'
import { StorageProvider } from './storage'

export type { AuditRecord }

export class AuditLogger {
  private storage: StorageProvider
  private readonly KEY = 'sluice_audit_trail'
  private readonly MAX_ENTRIES = 1000

  constructor(storage: StorageProvider) {
    this.storage = storage
  }

  /**
   * Log a decision record to storage.
   */
  async log(
    record: Omit<AuditRecord, 'timestamp' | 'transformations'> & {
      transformations?: AuditRecord['transformations']
    },
  ): Promise<void> {
    const fullRecord: AuditRecord = {
      transformations: [],
      ...record,
      timestamp: new Date().toISOString(),
    }

    try {
      await this.storage.lpush(this.KEY, JSON.stringify(fullRecord))
      await this.storage.ltrim(this.KEY, 0, this.MAX_ENTRIES - 1)
    } catch (error) {
      console.error('[Sluice] Audit logging failed:', error)
    }
  }

  /**
   * Retrieve the latest audit logs. Entries that do not parse against the
   * current schema are dropped rather than surfaced — a record we cannot
   * vouch for is not evidence.
   */
  async getLogs(limit = 100): Promise<AuditRecord[]> {
    const data = await this.storage.lrange(this.KEY, 0, limit - 1)
    const records: AuditRecord[] = []

    for (const entry of data) {
      let parsed: unknown
      try {
        parsed = JSON.parse(entry)
      } catch {
        console.warn('[Sluice] Discarded unparseable audit entry')
        continue
      }
      const result = AuditRecordSchema.safeParse(parsed)
      if (result.success) {
        records.push(result.data)
      } else {
        console.warn('[Sluice] Discarded audit entry that failed schema validation')
      }
    }

    return records
  }

  /**
   * Clear audit logs.
   */
  async clear(): Promise<void> {
    await this.storage.del(this.KEY)
  }
}

import { StorageProvider } from './storage';

export interface AuditRecord {
  timestamp: string;
  userId: string;
  destination: string;
  decision: 'forwarded' | 'blocked' | 'buffered' | 'scrubbed';
  reason: string;
  purposesRequired?: string;
  purposesGranted?: string[];
  transformationsApplied?: string[];
}

export class AuditLogger {
  private storage: StorageProvider;
  private readonly KEY = 'cg_audit_trail';
  private readonly MAX_ENTRIES = 1000;

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Log a decision record to storage.
   */
  async log(record: Omit<AuditRecord, 'timestamp'>): Promise<void> {
    const fullRecord: AuditRecord = {
      ...record,
      timestamp: new Date().toISOString(),
    };

    try {
      await this.storage.lpush(this.KEY, JSON.stringify(fullRecord));
      await this.storage.ltrim(this.KEY, 0, this.MAX_ENTRIES - 1);
    } catch (error) {
      console.error('[ConsentGuard] Audit logging failed:', error);
    }
  }

  /**
   * Retrieve the latest audit logs.
   */
  async getLogs(limit = 100): Promise<AuditRecord[]> {
    const data = await this.storage.lrange(this.KEY, 0, limit - 1);
    return data.map((entry) => JSON.parse(entry));
  }

  /**
   * Clear audit logs.
   */
  async clear(): Promise<void> {
    await this.storage.del(this.KEY);
  }
}

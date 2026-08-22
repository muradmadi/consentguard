import { ConsentState, ConsentStateSchema } from '@sluice/shared'
import { StorageProvider } from './storage'

export class ConsentManager {
  private storage: StorageProvider
  private defaultConsent: 'allow' | 'deny'
  private readonly KEY_PREFIX = 'consent:'

  constructor(storage: StorageProvider, defaultConsent: 'allow' | 'deny' = 'deny') {
    this.storage = storage
    this.defaultConsent = defaultConsent
  }

  /**
   * Fetch consent state for a user.
   * Defaults to "defaultConsent" (fail-closed to deny by default) if no state exists in storage or lookup fails.
   */
  async getConsent(userId: string): Promise<ConsentState & { _exists: boolean }> {
    try {
      const data = await this.storage.get(`${this.KEY_PREFIX}${userId}`)

      if (!data) {
        return { ...this.getDefaultConsent(userId), _exists: false }
      }

      const parsed = JSON.parse(data)
      const result = ConsentStateSchema.safeParse(parsed)

      if (!result.success) {
        console.warn(`[Sluice] Invalid consent state for user ${userId}, falling back to default.`)
        return { ...this.getDefaultConsent(userId), _exists: false }
      }

      return { ...result.data, _exists: true }
    } catch (error) {
      console.error(
        `[Sluice] Error fetching/parsing consent state for user ${userId}, failing closed:`,
        error,
      )
      return { ...this.getDefaultConsent(userId), _exists: false }
    }
  }

  /**
   * Save consent state for a user.
   */
  async setConsent(userId: string, state: ConsentState): Promise<void> {
    // 1-year TTL by default (31536000 seconds)
    await this.storage.set(`${this.KEY_PREFIX}${userId}`, JSON.stringify(state), 31536000)
  }

  private getDefaultConsent(userId: string): ConsentState {
    const purposes: Record<string, boolean> = {
      necessary: true,
    }
    if (this.defaultConsent === 'allow') {
      purposes.analytics = true
      purposes.marketing = true
      purposes.functional = true
    }
    return {
      userId,
      purposes,
      timestamp: Date.now(),
    }
  }

  /**
   * Check if a specific purpose is granted.
   */
  hasConsent(state: ConsentState, category: string): boolean {
    if (category === 'necessary') return true
    return !!state.purposes[category]
  }
}

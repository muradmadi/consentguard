import { ConsentState, ConsentStateSchema } from '@consentguard/shared';
import { StorageProvider } from './storage';

export class ConsentManager {
  private storage: StorageProvider;
  private readonly KEY_PREFIX = 'consent:';

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Fetch consent state for a user.
   * Defaults to "deny all" if no state exists in storage.
   */
  async getConsent(userId: string): Promise<ConsentState & { _exists: boolean }> {
    const data = await this.storage.get(`${this.KEY_PREFIX}${userId}`);
    
    if (!data) {
      return { ...this.getDefaultConsent(userId), _exists: false };
    }

    try {
      const parsed = JSON.parse(data);
      const result = ConsentStateSchema.safeParse(parsed);
      
      if (!result.success) {
        console.warn(`Invalid consent state for user ${userId}, falling back to default.`);
        return { ...this.getDefaultConsent(userId), _exists: false };
      }

      return { ...result.data, _exists: true };
    } catch (error) {
      console.error(`Error parsing consent state for user ${userId}:`, error);
      return { ...this.getDefaultConsent(userId), _exists: false };
    }
  }

  /**
   * Save consent state for a user.
   */
  async setConsent(userId: string, state: ConsentState): Promise<void> {
    // 1-year TTL by default (31536000 seconds)
    await this.storage.set(
      `${this.KEY_PREFIX}${userId}`,
      JSON.stringify(state),
      31536000
    );
  }

  private getDefaultConsent(userId: string): ConsentState {
    return {
      userId,
      purposes: {}, // Empty means all specific category checks will fail
      timestamp: Date.now(),
    };
  }

  /**
   * Check if a specific purpose is granted.
   */
  hasConsent(state: ConsentState, category: string): boolean {
    return !!state.purposes[category];
  }
}

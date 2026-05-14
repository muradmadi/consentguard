import Redis from 'ioredis';
import { ConsentState, ConsentStateSchema } from '@consentguard/shared';

export class ConsentManager {
  private redis: Redis;
  private readonly KEY_PREFIX = 'consent:';

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  /**
   * Fetch consent state for a user.
   * Defaults to "deny all" if no state exists in Redis.
   */
  async getConsent(userId: string): Promise<ConsentState> {
    const data = await this.redis.get(`${this.KEY_PREFIX}${userId}`);
    
    if (!data) {
      return this.getDefaultConsent(userId);
    }

    try {
      const parsed = JSON.parse(data);
      const result = ConsentStateSchema.safeParse(parsed);
      
      if (!result.success) {
        console.warn(`Invalid consent state for user ${userId}, falling back to default.`);
        return this.getDefaultConsent(userId);
      }

      return result.data;
    } catch (error) {
      console.error(`Error parsing consent state for user ${userId}:`, error);
      return this.getDefaultConsent(userId);
    }
  }

  /**
   * Save consent state for a user.
   */
  async setConsent(userId: string, state: ConsentState): Promise<void> {
    // 1-year TTL by default (31536000 seconds)
    await this.redis.set(
      `${this.KEY_PREFIX}${userId}`,
      JSON.stringify(state),
      'EX',
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

import Redis from 'ioredis';

export interface BufferedRequest {
  id: string;
  timestamp: number;
  destination: string;
  payload: any;
  originalUrl?: string;
  method: string;
  headers: Record<string, string>;
}

export class BufferManager {
  private redis: Redis;
  private readonly PREFIX = 'cg_buffer:';
  private readonly TTL = 3600; // 1 hour

  constructor(redisUrl: string) {
    this.redis = new Redis(redisUrl);
  }

  /**
   * Buffer a request for a user who hasn't given consent yet.
   */
  async bufferRequest(userId: string, data: Omit<BufferedRequest, 'id' | 'timestamp'>): Promise<void> {
    const request: BufferedRequest = {
      ...data,
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
    };

    const key = `${this.PREFIX}${userId}`;
    await this.redis.rpush(key, JSON.stringify(request));
    await this.redis.expire(key, this.TTL);
    
    console.log(`[ConsentGuard] Buffered request for ${userId} (Destination: ${data.destination})`);
  }

  /**
   * Retrieve and clear buffered requests for a user.
   */
  async getAndClearBuffer(userId: string): Promise<BufferedRequest[]> {
    const key = `${this.PREFIX}${userId}`;
    const data = await this.redis.lrange(key, 0, -1);
    await this.redis.del(key);
    
    return data.map(entry => JSON.parse(entry));
  }

  /**
   * Check if a user has buffered requests.
   */
  async hasBuffer(userId: string): Promise<boolean> {
    const count = await this.redis.llen(`${this.PREFIX}${userId}`);
    return count > 0;
  }
}

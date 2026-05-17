import Redis from 'ioredis';
import { StorageProvider } from './types';

export class RedisStorageProvider implements StorageProvider {
  private redis: Redis;

  constructor(url: string) {
    this.redis = new Redis(url);
  }

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.redis.set(key, value, 'EX', ttlSeconds);
    } else {
      await this.redis.set(key, value);
    }
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async lpush(key: string, value: string): Promise<void> {
    await this.redis.lpush(key, value);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.redis.lrange(key, start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.redis.ltrim(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return this.redis.llen(key);
  }

  async rpush(key: string, value: string): Promise<void> {
    await this.redis.rpush(key, value);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.redis.expire(key, seconds);
  }

  async flushAll(): Promise<void> {
    await this.redis.flushdb();
  }
}

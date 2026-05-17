import { StorageProvider } from './types';

export class HybridStorageProvider implements StorageProvider {
  private cache: Map<string, { value: string; expires: number }> = new Map();
  private maxCacheSize: number = 1000;
  private defaultTtlMs: number = 60000; // 1 minute local cache

  constructor(private primary: StorageProvider, options?: { maxSize?: number; ttlMs?: number }) {
    if (options?.maxSize) this.maxCacheSize = options.maxSize;
    if (options?.ttlMs) this.defaultTtlMs = options.ttlMs;
  }

  async get(key: string): Promise<string | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.value;
    }

    try {
      const value = await this.primary.get(key);
      if (value !== null) {
        this.setLocal(key, value);
      }
      return value;
    } catch (error) {
      console.warn(`[ConsentGuard] Primary storage error, falling back to local cache for ${key}`);
      // Fallback: return expired cache if primary fails (Stale-While-Revalidate pattern)
      return cached ? cached.value : null;
    }
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    await this.primary.set(key, value, ttlSeconds);
    this.setLocal(key, value, ttlSeconds ? ttlSeconds * 1000 : undefined);
  }

  async del(key: string): Promise<void> {
    await this.primary.del(key);
    this.cache.delete(key);
  }

  // Helper to manage local cache size and expiration
  private setLocal(key: string, value: string, ttlMs?: number) {
    if (this.cache.size >= this.maxCacheSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    this.cache.set(key, {
      value,
      expires: Date.now() + (ttlMs || this.defaultTtlMs)
    });
  }

  // Pass-through for list operations (not cached locally)
  async lpush(key: string, value: string): Promise<void> {
    await this.primary.lpush(key, value);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.primary.lrange(key, start, stop);
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    await this.primary.ltrim(key, start, stop);
  }

  async llen(key: string): Promise<number> {
    return this.primary.llen(key);
  }

  async rpush(key: string, value: string): Promise<void> {
    await this.primary.rpush(key, value);
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.primary.expire(key, seconds);
    const cached = this.cache.get(key);
    if (cached) {
      cached.expires = Date.now() + (seconds * 1000);
    }
  }

  async flushAll(): Promise<void> {
    await this.primary.flushAll();
    this.cache.clear();
  }
}

export interface StorageProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  lpush(key: string, value: string): Promise<void>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  ltrim(key: string, start: number, stop: number): Promise<void>;
  llen(key: string): Promise<number>;
  rpush(key: string, value: string): Promise<void>;
  expire(key: string, seconds: number): Promise<void>;
  flushAll(): Promise<void>;
}

import { StorageProvider } from './types'

export class MemoryStorageProvider implements StorageProvider {
  private data: Map<string, string> = new Map()
  private lists: Map<string, string[]> = new Map()
  private ttls: Map<string, number> = new Map()

  async get(key: string): Promise<string | null> {
    this.checkTtl(key)
    return this.data.get(key) || null
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    this.data.set(key, value)
    if (ttlSeconds) {
      this.ttls.set(key, Date.now() + ttlSeconds * 1000)
    }
  }

  async del(key: string): Promise<void> {
    this.data.delete(key)
    this.lists.delete(key)
    this.ttls.delete(key)
  }

  async lpush(key: string, value: string): Promise<void> {
    const list = this.lists.get(key) || []
    list.unshift(value)
    this.lists.set(key, list)
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) || []
    // Stop is inclusive in Redis
    const end = stop === -1 ? list.length : stop + 1
    return list.slice(start, end)
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    let list = this.lists.get(key) || []
    const end = stop === -1 ? list.length : stop + 1
    list = list.slice(start, end)
    this.lists.set(key, list)
  }

  async llen(key: string): Promise<number> {
    return (this.lists.get(key) || []).length
  }

  async rpush(key: string, value: string): Promise<void> {
    const list = this.lists.get(key) || []
    list.push(value)
    this.lists.set(key, list)
  }

  async expire(key: string, seconds: number): Promise<void> {
    this.ttls.set(key, Date.now() + seconds * 1000)
  }

  async flushAll(): Promise<void> {
    this.data.clear()
    this.lists.clear()
    this.ttls.clear()
  }

  private checkTtl(key: string) {
    const expiry = this.ttls.get(key)
    if (expiry && expiry < Date.now()) {
      this.del(key)
    }
  }
}

import { StorageProvider } from './types'

export class CloudflareKVStorageProvider implements StorageProvider {
  private namespace: any

  constructor(namespace: any) {
    if (!namespace) {
      throw new Error('Cloudflare KV Storage Provider requires a valid KV namespace binding.')
    }
    this.namespace = namespace
  }

  async get(key: string): Promise<string | null> {
    return (await this.namespace.get(key)) || null
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const options: Record<string, any> = {}
    if (ttlSeconds) {
      options.expirationTtl = ttlSeconds
    }
    await this.namespace.put(key, value, options)
  }

  async del(key: string): Promise<void> {
    await this.namespace.delete(key)
    await this.namespace.delete(`list:${key}`)
  }

  private async getList(key: string): Promise<string[]> {
    const data = await this.namespace.get(`list:${key}`)
    if (!data) return []
    try {
      return JSON.parse(data)
    } catch {
      return []
    }
  }

  private async setList(key: string, list: string[]): Promise<void> {
    await this.namespace.put(`list:${key}`, JSON.stringify(list))
  }

  async lpush(key: string, value: string): Promise<void> {
    const list = await this.getList(key)
    list.unshift(value)
    await this.setList(key, list)
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = await this.getList(key)
    const end = stop === -1 ? list.length : stop + 1
    return list.slice(start, end)
  }

  async ltrim(key: string, start: number, stop: number): Promise<void> {
    const list = await this.getList(key)
    const end = stop === -1 ? list.length : stop + 1
    const trimmed = list.slice(start, end)
    await this.setList(key, trimmed)
  }

  async llen(key: string): Promise<number> {
    const list = await this.getList(key)
    return list.length
  }

  async rpush(key: string, value: string): Promise<void> {
    const list = await this.getList(key)
    list.push(value)
    await this.setList(key, list)
  }

  async expire(key: string, seconds: number): Promise<void> {
    // KV put has static expiration. For expire, we read and put again with TTL.
    const val = await this.namespace.get(key)
    if (val) {
      await this.namespace.put(key, val, { expirationTtl: seconds })
    }
    const listVal = await this.namespace.get(`list:${key}`)
    if (listVal) {
      await this.namespace.put(`list:${key}`, listVal, { expirationTtl: seconds })
    }
  }

  async flushAll(): Promise<void> {
    if (typeof this.namespace.list === 'function') {
      let cursor: string | undefined
      do {
        const result = await this.namespace.list({ cursor })
        for (const key of result.keys) {
          await this.namespace.delete(key.name)
        }
        cursor = result.list_complete ? undefined : result.cursor
      } while (cursor)
    }
  }
}

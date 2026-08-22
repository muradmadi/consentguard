import { StorageProvider } from './storage'

export interface BufferedRequest {
  id: string
  timestamp: number
  destination: string
  payload: any
  originalUrl?: string
  method: string
  headers: Record<string, string>
}

export class BufferManager {
  private storage: StorageProvider
  private readonly PREFIX = 'sluice_buffer:'
  private readonly TTL = 3600 // 1 hour

  constructor(storage: StorageProvider) {
    this.storage = storage
  }

  /**
   * Buffer a request for a user who hasn't given consent yet.
   */
  async bufferRequest(
    userId: string,
    data: Omit<BufferedRequest, 'id' | 'timestamp'>,
  ): Promise<void> {
    const request: BufferedRequest = {
      ...data,
      id: Math.random().toString(36).substring(7),
      timestamp: Date.now(),
    }

    const key = `${this.PREFIX}${userId}`
    await this.storage.rpush(key, JSON.stringify(request))
    await this.storage.expire(key, this.TTL)

    console.log(`[Sluice] Buffered request for ${userId} (Destination: ${data.destination})`)
  }

  /**
   * Retrieve and clear buffered requests for a user.
   */
  async getAndClearBuffer(userId: string): Promise<BufferedRequest[]> {
    const key = `${this.PREFIX}${userId}`
    const data = await this.storage.lrange(key, 0, -1)
    await this.storage.del(key)

    return data.map((entry) => JSON.parse(entry))
  }

  /**
   * Check if a user has buffered requests.
   */
  async hasBuffer(userId: string): Promise<boolean> {
    const count = await this.storage.llen(`${this.PREFIX}${userId}`)
    return count > 0
  }
}

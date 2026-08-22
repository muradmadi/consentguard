import { StorageProvider, RedisStorageProvider, MemoryStorageProvider } from '../engine/storage'
import { createApp } from '../app'

export interface MiddlewareConfig {
  storage?: StorageProvider
  redisUrl?: string
  env?: any
}

/**
 * Mountable Hono application middleware generator.
 * Allows developers to mount the Sluice proxy cleanly:
 * @example
 *   app.route('/analytics', consentProxyMiddleware({ redisUrl: '...' }))
 */
export function consentProxyMiddleware(options: MiddlewareConfig = {}) {
  // 1. Resolve Storage Provider
  let storage = options.storage
  if (!storage) {
    const env = options.env || (typeof process !== 'undefined' ? process.env : {})
    const redisUrl = options.redisUrl || env.REDIS_URL || env.redisUrl || 'redis://localhost:6379'
    const nodeEnv = env.NODE_ENV || env.env || 'development'
    const isTest = nodeEnv === 'test'

    storage =
      isTest || env.SLUICE_STORAGE === 'memory'
        ? new MemoryStorageProvider()
        : new RedisStorageProvider(redisUrl)
  }

  // 2. Create and return the configured Hono application instance
  return createApp(storage, options.env || {})
}

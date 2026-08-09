import { serve } from '@hono/node-server'
import { createApp } from './app'
import { RedisStorageProvider, MemoryStorageProvider } from './engine/storage'
import { serverConfig } from './config'

const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string>)

const storage = serverConfig.env === 'test' || env.CG_STORAGE === 'memory'
  ? new MemoryStorageProvider()
  : new RedisStorageProvider(serverConfig.redisUrl)

const app = createApp(storage, env)

console.log(`[ConsentGuard] Proxy listening on http://localhost:${serverConfig.port}`)
if (serverConfig.allowedOrigins.length === 0) {
  console.warn('[ConsentGuard] CG_ALLOWED_ORIGINS is not set — the proxy will accept any origin. Set it in production.')
}
if (!serverConfig.ga4.measurementId || !serverConfig.ga4.apiSecret) {
  console.warn('[ConsentGuard] GA4_MEASUREMENT_ID / GA4_API_SECRET not set — GA4 forwarding is disabled (events will 204).')
}

serve({ fetch: app.fetch, port: serverConfig.port })

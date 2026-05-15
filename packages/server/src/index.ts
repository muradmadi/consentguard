import { serve } from '@hono/node-server'
import { createApp } from './app'
import { RedisStorageProvider, MemoryStorageProvider } from './engine/storage'
import { serverConfig } from './config'

const storage = serverConfig.env === 'test' || process.env.CG_STORAGE === 'memory' 
  ? new MemoryStorageProvider()
  : new RedisStorageProvider(serverConfig.redisUrl)

const app = createApp(storage, serverConfig)

const port = serverConfig.port
console.log(`[ConsentGuard] Proxy running on Node.js (Port: ${port})`)

serve({
  fetch: app.fetch,
  port
})

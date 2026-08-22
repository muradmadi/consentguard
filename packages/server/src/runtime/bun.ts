import { createApp } from '../app'
import { MemoryStorageProvider, RedisStorageProvider } from '../engine/storage'
import { getServerConfig } from '../config'

const config = getServerConfig(process.env)
const storage = config.redisUrl ? new RedisStorageProvider(config.redisUrl) : new MemoryStorageProvider()
const app = createApp(storage, config)

console.log(`[Sluice] Proxy running on Bun (Port: ${config.port})`)

export default {
  port: config.port,
  fetch: app.fetch,
}

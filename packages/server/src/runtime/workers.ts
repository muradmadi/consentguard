import { createApp } from '../app'
import { MemoryStorageProvider } from '../engine/storage'

export default {
  async fetch(request: Request, env: any, ctx: any) {
    // In Workers, we use MemoryStorage for the proxy state if Redis isn't provided
    // Ideally, users would provide a Redis URL for persistence across worker instances
    const storage = new MemoryStorageProvider()
    const app = createApp(storage, env)
    return app.fetch(request, env, ctx)
  },
}

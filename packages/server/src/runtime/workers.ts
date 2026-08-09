import { createApp } from '../app'
import { MemoryStorageProvider, CloudflareKVStorageProvider } from '../engine/storage'

export default {
  async fetch(request: Request, env: any, ctx: any) {
    // In Workers, if env.CONSENT_STORE KV namespace is bound, use it for edge-native persistence.
    // Otherwise fallback to MemoryStorageProvider for local sandbox/testing.
    const storage = env.CONSENT_STORE 
      ? new CloudflareKVStorageProvider(env.CONSENT_STORE)
      : new MemoryStorageProvider()
      
    const app = createApp(storage, env)
    return app.fetch(request, env, ctx)
  },
}


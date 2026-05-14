import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { defaultConfig } from '@consentguard/shared'

const app = new Hono()

app.get('/health', (c) => c.json({ status: 'ok' }))

const port = process.env.PORT ? parseInt(process.env.PORT) : defaultConfig.proxy.port
console.log(`Server is running on port ${port}`)

serve({
  fetch: app.fetch,
  port
})

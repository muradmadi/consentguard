import { serve } from '@hono/node-server'
import { createApp } from './app'
import { RedisStorageProvider, MemoryStorageProvider } from './engine/storage'
import { NullAuditSink, type AuditSink } from './engine/audit'
import { FileAuditSink } from './engine/audit/sink/file'
import { serverConfig } from './config'

const env = typeof process !== 'undefined' ? process.env : ({} as Record<string, string>)

const storage =
  serverConfig.env === 'test' || env.SLUICE_STORAGE === 'memory'
    ? new MemoryStorageProvider()
    : new RedisStorageProvider(serverConfig.redisUrl)

// The durable record. Built here rather than inside `createApp`, because this
// is the entry point that knows it has a filesystem.
const auditSink: AuditSink = serverConfig.auditDir
  ? new FileAuditSink({
      dir: serverConfig.auditDir,
      retentionDays: serverConfig.auditRetentionDays,
    })
  : new NullAuditSink()

const app = createApp(storage, env, { auditSink })

console.log(`[Sluice] Proxy listening on http://localhost:${serverConfig.port}`)
if (serverConfig.allowedOrigins.length === 0) {
  console.warn(
    '[Sluice] SLUICE_ALLOWED_ORIGINS is not set — the proxy will accept any origin. Set it in production.',
  )
}
if (auditSink.configured) {
  console.log(
    `[Sluice] Audit records are kept in ${serverConfig.auditDir} for ${serverConfig.auditRetentionDays} days.`,
  )
} else {
  console.warn(
    '[Sluice] SLUICE_AUDIT_DIR is empty — no durable audit record. The audit is a ' +
      `${serverConfig.auditCacheEntries}-entry cache that rolls over, and cannot be exported or verified.`,
  )
}
if (!serverConfig.ga4.measurementId || !serverConfig.ga4.apiSecret) {
  console.warn(
    '[Sluice] GA4_MEASUREMENT_ID / GA4_API_SECRET not set — GA4 forwarding is disabled (events will 204).',
  )
}

serve({ fetch: app.fetch, port: serverConfig.port })

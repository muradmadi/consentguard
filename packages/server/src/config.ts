import { PiiDetectorSchema, type PiiDetector } from '@sluice/shared'
import { DEFAULT_DETECTORS } from './engine/detectors/patterns'

/**
 * Which value-based detectors run against every payload.
 *
 * Unset means the default set. `off` disables the scan entirely and leaves only
 * the destinations' declared paths — a deliberate downgrade, not a tuning knob.
 * Unknown names are dropped with a warning rather than silently ignored.
 */
const parseDetectors = (raw: unknown): PiiDetector[] => {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DETECTORS

  const names = String(raw)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

  if (names.length === 1 && (names[0] === 'off' || names[0] === 'none')) return []

  const detectors: PiiDetector[] = []
  for (const name of names) {
    const parsed = PiiDetectorSchema.safeParse(name)
    if (parsed.success) detectors.push(parsed.data)
    else console.warn(`[Sluice] Ignoring unknown PII detector: ${name}`)
  }
  return detectors
}

/**
 * Proxy Server Configuration
 * Runtime-agnostic. Runtimes inject their own env vars.
 */
export const getServerConfig = (env: any = {}) => {
  const nodeEnv =
    env.NODE_ENV ||
    env.env ||
    (typeof process !== 'undefined' ? process.env.NODE_ENV : '') ||
    'development'
  const isDev = nodeEnv === 'development' || nodeEnv === 'test'

  const adminSecret =
    env.ADMIN_SECRET || env.adminSecret || (isDev ? 'dev-admin-secret' : undefined)
  if (!adminSecret) {
    throw new Error(
      'FATAL: ADMIN_SECRET is missing. Sluice cannot start in a non-dev environment without it.',
    )
  }

  const allowedOriginsRaw = env.SLUICE_ALLOWED_ORIGINS || env.allowedOrigins || ''
  const allowedOrigins = String(allowedOriginsRaw)
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean)

  return {
    port: parseInt(env.PORT || env.port || '3000'),
    redisUrl: env.REDIS_URL || env.redisUrl || 'redis://localhost:6379',
    adminSecret,
    // Optional webhook secret for CMP callbacks; falls back to adminSecret if unset.
    webhookSecret: env.SLUICE_WEBHOOK_SECRET || env.webhookSecret || adminSecret,
    env: nodeEnv,
    bufferPending: env.BUFFER_PENDING !== 'false' && env.bufferPending !== false,
    hashSalt: env.SLUICE_HASH_SALT || env.hashSalt || 'default-salt',
    enableCache: env.SLUICE_ENABLE_CACHE === 'true' || env.enableCache === true,
    cacheTtl: parseInt(env.SLUICE_CACHE_TTL || env.cacheTtl || '60000'),
    defaultConsent: env.SLUICE_DEFAULT_CONSENT || env.defaultConsent || 'deny',
    // Empty list = permissive (dev-friendly). Non-empty = strict allowlist.
    allowedOrigins,
    detectors: parseDetectors(env.SLUICE_DETECTORS ?? env.detectors),
    ga4: {
      measurementId: env.GA4_MEASUREMENT_ID || env.ga4MeasurementId || '',
      apiSecret: env.GA4_API_SECRET || env.ga4ApiSecret || '',
    },
  }
}

export type ServerConfig = ReturnType<typeof getServerConfig>

// For backward compatibility and Node.js default usage
export const serverConfig = getServerConfig(typeof process !== 'undefined' ? process.env : {})

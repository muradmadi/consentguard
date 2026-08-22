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

/** A configured size limit, ignoring anything that is not a positive number. */
const parsePositiveInt = (raw: unknown, fallback: number): number => {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = Number(raw)
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * The admin bearer for a development run, minted once per process.
 *
 * There used to be a fixed development token written here. A build that inlined
 * it shipped it, and a deployment that lost its NODE_ENV fell back to a
 * credential printed in the repository. A value nobody can look up beforehand
 * costs a line of log output and removes the whole class.
 */
let generatedDevSecret: string | undefined

const developmentAdminSecret = (): string => {
  if (!generatedDevSecret) {
    generatedDevSecret =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    console.warn(
      `[Sluice] ADMIN_SECRET is not set. Generated a development admin token for this process: ${generatedDevSecret}`,
    )
  }
  return generatedDevSecret
}

/**
 * Largest request body `/ingest` will read. A beacon is a few hundred bytes;
 * anything approaching this is not one.
 */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024

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
    env.ADMIN_SECRET || env.adminSecret || (isDev ? developmentAdminSecret() : undefined)
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
    // Optional read-only bearer for a metrics collector. Unset means /metrics
    // takes the admin secret and nothing else.
    metricsToken: env.SLUICE_METRICS_TOKEN || env.metricsToken || '',
    maxBodyBytes: parsePositiveInt(
      env.SLUICE_MAX_BODY_BYTES ?? env.maxBodyBytes,
      DEFAULT_MAX_BODY_BYTES,
    ),
    env: nodeEnv,
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

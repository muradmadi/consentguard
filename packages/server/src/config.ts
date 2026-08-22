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

/** A boolean env var, where anything but an explicit `false` means on. */
const parseBool = (raw: unknown, fallback: boolean): boolean => {
  if (raw === undefined || raw === null || raw === '') return fallback
  const value = String(raw).trim().toLowerCase()
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true
  return fallback
}

/**
 * Where the durable, append-only audit record is written.
 *
 * On by default, because a firewall whose evidence is a thousand-entry cache
 * that rolls over silently cannot answer the only question anyone will ask it
 * months later. An explicitly empty value turns the sink off and leaves the
 * cache, which is what a runtime without a filesystem needs.
 *
 * Only the Node entry point reads this: `createApp` takes the sink as an
 * argument so the app itself never reaches for a filesystem.
 */
const DEFAULT_AUDIT_DIR = './.sluice/audit'

/** How long the record is kept. Replaces a hard-coded thousand-entry cap. */
const DEFAULT_AUDIT_RETENTION_DAYS = 90

/** Screenfuls for the dashboard, in front of the sink. Not a retention policy. */
const DEFAULT_AUDIT_CACHE_ENTRIES = 1000

/** Ceiling on the scan that derives rule health, so an operator page stays cheap. */
const DEFAULT_RULE_HEALTH_SCAN = 20000

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

  const auditDirRaw = env.SLUICE_AUDIT_DIR ?? env.auditDir
  const auditDir = auditDirRaw === undefined ? DEFAULT_AUDIT_DIR : String(auditDirRaw).trim()

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
    // Empty path = no durable sink; the audit is the display cache and nothing more.
    auditDir,
    auditRetentionDays: parsePositiveInt(
      env.SLUICE_AUDIT_RETENTION_DAYS ?? env.auditRetentionDays,
      DEFAULT_AUDIT_RETENTION_DAYS,
    ),
    // A configured sink that cannot write stops the firewall forwarding: if we
    // cannot prove what we did, we stop doing it. Off reverts to log-and-continue.
    auditRequired: parseBool(env.SLUICE_AUDIT_REQUIRED ?? env.auditRequired, true),
    auditCacheEntries: parsePositiveInt(
      env.SLUICE_AUDIT_CACHE_ENTRIES ?? env.auditCacheEntries,
      DEFAULT_AUDIT_CACHE_ENTRIES,
    ),
    ruleHealthScan: parsePositiveInt(
      env.SLUICE_RULE_HEALTH_SCAN ?? env.ruleHealthScan,
      DEFAULT_RULE_HEALTH_SCAN,
    ),
    ga4: {
      measurementId: env.GA4_MEASUREMENT_ID || env.ga4MeasurementId || '',
      apiSecret: env.GA4_API_SECRET || env.ga4ApiSecret || '',
    },
  }
}

export type ServerConfig = ReturnType<typeof getServerConfig>

// For backward compatibility and Node.js default usage
export const serverConfig = getServerConfig(typeof process !== 'undefined' ? process.env : {})

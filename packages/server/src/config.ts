/**
 * Proxy Server Configuration
 * Runtime-agnostic. Runtimes inject their own env vars.
 */
export const getServerConfig = (env: any = {}) => {
  const nodeEnv = env.NODE_ENV || env.env || (typeof process !== 'undefined' ? process.env.NODE_ENV : '') || 'development';
  const isDev = nodeEnv === 'development' || nodeEnv === 'test';

  const adminSecret = env.ADMIN_SECRET || env.adminSecret || (isDev ? 'dev-admin-secret' : undefined);
  if (!adminSecret) {
    throw new Error('FATAL: ADMIN_SECRET is missing. Sluice cannot start in a non-dev environment without it.');
  }

  const allowedOriginsRaw = env.SLUICE_ALLOWED_ORIGINS || env.allowedOrigins || '';
  const allowedOrigins = String(allowedOriginsRaw)
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

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
    ga4: {
      measurementId: env.GA4_MEASUREMENT_ID || env.ga4MeasurementId || '',
      apiSecret: env.GA4_API_SECRET || env.ga4ApiSecret || '',
    },
  };
};

export type ServerConfig = ReturnType<typeof getServerConfig>;

// For backward compatibility and Node.js default usage
export const serverConfig = getServerConfig(typeof process !== 'undefined' ? process.env : {});

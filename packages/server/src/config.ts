import { defaultConfig } from '@consentguard/shared';

/**
 * Proxy Server Configuration
 * This is now runtime-agnostic. Runtimes should inject their own env vars.
 */
export const getServerConfig = (env: any = {}) => {
  return {
    port: parseInt(env.PORT || env.port || '3000'),
    redisUrl: env.REDIS_URL || env.redisUrl || 'redis://localhost:6379',
    proxySecret: env.PROXY_SECRET || env.proxySecret || 'dev-proxy-secret',
    adminSecret: env.ADMIN_SECRET || env.adminSecret || 'dev-admin-secret',
    env: env.NODE_ENV || env.env || 'development',
    bufferPending: env.BUFFER_PENDING !== 'false' && env.bufferPending !== false,
    hashSalt: env.CG_HASH_SALT || env.hashSalt || 'default-salt',
    enableCache: env.CG_ENABLE_CACHE === 'true' || env.enableCache === true,
    cacheTtl: parseInt(env.CG_CACHE_TTL || env.cacheTtl || '60000'),
  };
};

// For backward compatibility and Node.js default usage
export const serverConfig = getServerConfig(typeof process !== 'undefined' ? process.env : {});

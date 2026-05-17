import { defaultConfig } from '@consentguard/shared';

/**
 * Proxy Server Configuration
 * This is now runtime-agnostic. Runtimes should inject their own env vars.
 */
export const getServerConfig = (env: any = {}) => {
  const nodeEnv = env.NODE_ENV || env.env || (typeof process !== 'undefined' ? process.env.NODE_ENV : '') || 'development';
  const isTest = nodeEnv === 'test';
  
  const cgAuthSecret = env.CG_AUTH_SECRET || env.PROXY_SECRET || env.proxySecret || (nodeEnv === 'development' || isTest ? 'dev-proxy-secret' : undefined);

  if (!cgAuthSecret && !isTest) {
    throw new Error('FATAL: CG_AUTH_SECRET is missing from the environment. ConsentGuard server cannot start.');
  }

  return {
    port: parseInt(env.PORT || env.port || '3000'),
    redisUrl: env.REDIS_URL || env.redisUrl || 'redis://localhost:6379',
    proxySecret: cgAuthSecret || 'dev-proxy-secret',
    adminSecret: env.ADMIN_SECRET || env.adminSecret || 'dev-admin-secret',
    env: nodeEnv,
    bufferPending: env.BUFFER_PENDING !== 'false' && env.bufferPending !== false,
    hashSalt: env.CG_HASH_SALT || env.hashSalt || 'default-salt',
    enableCache: env.CG_ENABLE_CACHE === 'true' || env.enableCache === true,
    cacheTtl: parseInt(env.CG_CACHE_TTL || env.cacheTtl || '60000'),
    defaultConsent: env.CG_DEFAULT_CONSENT || env.defaultConsent || 'deny',
  };
};

// For backward compatibility and Node.js default usage
export const serverConfig = getServerConfig(typeof process !== 'undefined' ? process.env : {});

import { defaultConfig } from '@consentguard/shared';

/**
 * Proxy Server Configuration
 */
export const serverConfig = {
  port: process.env.PORT ? parseInt(process.env.PORT) : defaultConfig.proxy.port,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  proxySecret: process.env.PROXY_SECRET || 'dev-proxy-secret',
  adminSecret: process.env.ADMIN_SECRET || 'dev-admin-secret',
  env: process.env.NODE_ENV || 'development',
};

/**
 * In a future update, this could load from a .consentguardrc.json file
 * using a library like 'cosmiconfig'.
 */

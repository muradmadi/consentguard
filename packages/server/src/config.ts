import { defaultConfig } from '@consentguard/shared';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Load configuration from file if exists
 */
const loadFileConfig = () => {
  const configPath = path.join(process.cwd(), '.consentguardrc.json');
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error('[ConsentGuard] Failed to parse .consentguardrc.json:', error);
    }
  }
  return {};
};

const fileConfig = loadFileConfig();

/**
 * Proxy Server Configuration
 */
export const serverConfig = {
  port: process.env.PORT || fileConfig.port ? parseInt(process.env.PORT || fileConfig.port) : defaultConfig.proxy.port,
  redisUrl: process.env.REDIS_URL || fileConfig.redisUrl || 'redis://localhost:6379',
  proxySecret: process.env.PROXY_SECRET || fileConfig.proxySecret || 'dev-proxy-secret',
  adminSecret: process.env.ADMIN_SECRET || fileConfig.adminSecret || 'dev-admin-secret',
  env: process.env.NODE_ENV || fileConfig.env || 'development',
  bufferPending: process.env.BUFFER_PENDING !== 'false' && fileConfig.bufferPending !== false,
  hashSalt: process.env.CG_HASH_SALT || fileConfig.hashSalt || 'default-salt',
};

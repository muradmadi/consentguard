import { createHash } from 'crypto';
import { getServerConfig } from '../../config';

/**
 * Hash transformation: replaces a string value with its SHA-256 hash + salt.
 * Supports salt-based hashing for better privacy.
 */
export const applyHash = (obj: any, head: string, env: any = process.env) => {
  if (obj && typeof obj === 'object' && typeof obj[head] === 'string') {
    // Priority: Environment Variable > Default Config > Static Fallback
    const config = getServerConfig(env);
    const salt = env.CG_HASH_SALT || config.hashSalt || 'cg-default-salt-12345';
    
    // Convert to lowercase before hashing (industry standard for email/PII hashing)
    const normalized = obj[head].trim().toLowerCase();
    
    obj[head] = createHash('sha256')
      .update(`${normalized}${salt}`)
      .digest('hex');
    
    // console.log(`[ConsentGuard] Hashed field: ${head}`);
  }
};

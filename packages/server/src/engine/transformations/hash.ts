import { createHash } from 'crypto';
import { serverConfig } from '../../config';

/**
 * Hash transformation: replaces a string value with its SHA-256 hash + salt.
 */
export const applyHash = (obj: any, head: string) => {
  if (obj && typeof obj === 'object' && typeof obj[head] === 'string') {
    const salt = serverConfig.hashSalt;
    obj[head] = createHash('sha256').update(`${obj[head]}${salt}`).digest('hex');
  }
};

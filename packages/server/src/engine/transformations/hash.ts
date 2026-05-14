import { createHash } from 'crypto';

/**
 * Hash transformation: replaces a string value with its SHA-256 hash.
 */
export const applyHash = (obj: any, head: string) => {
  if (obj && typeof obj === 'object' && typeof obj[head] === 'string') {
    obj[head] = createHash('sha256').update(obj[head]).digest('hex');
  }
};

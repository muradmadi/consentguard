import { createHash } from 'crypto'
import { getServerConfig } from '../../config'

/**
 * Hash transformation: replaces a string value with its SHA-256 hash + salt.
 * Returns true if the field was a string and was hashed.
 */
export const applyHash = (obj: any, head: string, env: any = process.env): boolean => {
  if (!obj || typeof obj !== 'object' || typeof obj[head] !== 'string') return false

  // Priority: Environment Variable > Default Config > Static Fallback
  const config = getServerConfig(env)
  const salt = env.SLUICE_HASH_SALT || config.hashSalt || 'sluice-default-salt-12345'

  // Convert to lowercase before hashing (industry standard for email/PII hashing)
  const normalized = obj[head].trim().toLowerCase()

  obj[head] = createHash('sha256').update(`${normalized}${salt}`).digest('hex')

  return true
}

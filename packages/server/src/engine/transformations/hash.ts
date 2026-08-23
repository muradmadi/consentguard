import { createHash, createHmac } from 'crypto'
import type { HashMode, NormalizeFormat } from '@sluice/shared'
import { normalizeForMatchKey } from './normalize'

/**
 * The two hashes, built once from the secret the app was constructed with.
 *
 * There used to be one function doing both jobs: a salted SHA-256, which is
 * neither. It is not a match key — Meta specifies normalise-then-SHA-256 with no
 * salt, so a salted digest matched nothing at the vendor while the audit
 * recorded a successful transformation — and it was not a pseudonym either,
 * because the salt defaulted to a literal published in this repository.
 */
export interface Hasher {
  /** Keyed HMAC-SHA256. Stable within a deployment, opaque outside it. */
  pseudonymize(value: string): string
  /**
   * The vendor's contract: normalise, then unsalted SHA-256. Returns null when
   * the value cannot be normalised into the format, because the digest of an
   * empty string is a constant that would read as a real identity.
   */
  matchKey(value: string, format: NormalizeFormat): string | null
}

/**
 * Built at construction from the injected env, not per field per request.
 *
 * Throws on an empty secret rather than falling back to one. A default secret is
 * a published secret, and a pseudonym under a published key is just the value
 * with extra steps — anyone can hash a candidate list and match it back.
 * `getServerConfig` refuses to start without one outside development, so this
 * is the second line rather than the first.
 */
export function createHasher(secret: string): Hasher {
  if (!secret) {
    throw new Error('FATAL: a hash secret is required. Set SLUICE_HASH_SECRET.')
  }

  return {
    pseudonymize(value: string): string {
      // Trimmed and lowercased first so that the same address written two ways
      // gets one pseudonym; without it the token stops being stable per user,
      // which is the only property a pseudonym has to have.
      return createHmac('sha256', secret).update(value.trim().toLowerCase()).digest('hex')
    },
    matchKey(value: string, format: NormalizeFormat): string | null {
      const normalized = normalizeForMatchKey(value, format)
      if (!normalized) return null
      return createHash('sha256').update(normalized).digest('hex')
    },
  }
}

export interface HashSpec {
  mode: HashMode
  /** Required by `match_key`; the rule schema enforces that. */
  normalize?: NormalizeFormat
}

/**
 * What `applyHash` actually did. A match key whose value will not normalise is
 * removed instead of hashed, and says so: the audit records the action taken,
 * never the one that was configured.
 */
export type HashOutcome = { action: 'hash'; mode: HashMode } | { action: 'strip' } | null

export const applyHash = (obj: any, head: string, hasher: Hasher, spec: HashSpec): HashOutcome => {
  if (!obj || typeof obj !== 'object' || typeof obj[head] !== 'string') return null

  if (spec.mode === 'match_key' && spec.normalize) {
    // Meta's pixel with Advanced Matching turned on hashes `em` and `ph` in the
    // browser, so the value arriving here is already the digest the vendor will
    // match against. Hashing it a second time produces a well-formed digest of a
    // digest, which matches nobody — the exact silent failure the modes exist to
    // prevent. Nothing changed, so there is no audit entry either.
    if (isSha256Hex(obj[head])) return null

    const digest = hasher.matchKey(obj[head], spec.normalize)
    if (digest === null) {
      // Declared a match key, cannot be one. Forwarding it unchanged would leak
      // the value; hashing an empty normalisation would forward a constant.
      delete obj[head]
      return { action: 'strip' }
    }
    obj[head] = digest
    return { action: 'hash', mode: 'match_key' }
  }

  obj[head] = hasher.pseudonymize(obj[head])
  return { action: 'hash', mode: 'pseudonymize' }
}

/**
 * A value that is already the vendor's match key.
 *
 * Only consulted for `match_key`, where the output is an unsalted SHA-256 and
 * the collision with a genuine 64-character hex payload value is not worth
 * worrying about. A pseudonymising hash still re-hashes: its output is keyed to
 * this deployment, so an incoming digest is somebody else's value, not ours.
 */
function isSha256Hex(value: string): boolean {
  return /^[0-9a-f]{64}$/i.test(value)
}

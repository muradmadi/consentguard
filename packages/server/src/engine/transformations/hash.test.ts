import { describe, it, expect } from 'vitest'
import { createHash, createHmac } from 'crypto'
import { applyHash, createHasher } from './hash'
import { normalizeForMatchKey } from './normalize'

const hasher = createHasher('a-real-secret')

describe('createHasher', () => {
  it('refuses a missing secret rather than inventing one', () => {
    expect(() => createHasher('')).toThrow(/SLUICE_HASH_SECRET/)
  })
})

/**
 * The failure this replaces was silent in both directions: a salted digest
 * matched nothing at the vendor, and a digest anyone could recompute was being
 * called a pseudonym. Each mode is pinned against the primitive it claims to be.
 */
describe('pseudonymize', () => {
  it('is a keyed HMAC, not a bare digest of the value', () => {
    const digest = hasher.pseudonymize('alice@example.com')
    expect(digest).toBe(
      createHmac('sha256', 'a-real-secret').update('alice@example.com').digest('hex'),
    )
    expect(digest).not.toBe(createHash('sha256').update('alice@example.com').digest('hex'))
  })

  it('gives a different digest under a different secret', () => {
    expect(hasher.pseudonymize('alice@example.com')).not.toBe(
      createHasher('another-secret').pseudonymize('alice@example.com'),
    )
  })

  it('gives one token for the same address written two ways', () => {
    expect(hasher.pseudonymize('  Alice@Example.com ')).toBe(
      hasher.pseudonymize('alice@example.com'),
    )
  })
})

/**
 * Vendor vectors. Each expected digest is the unsalted SHA-256 of the form the
 * vendor documents hashing — Meta's Conversions API specifies lowercase and
 * trimmed for `em`, and digits only with the country code and no leading zeros
 * for `ph`. They are pinned as literals on purpose: a change to normalisation
 * fails the gate here rather than failing the campaign silently.
 */
describe('match_key', () => {
  const EMAIL_DIGEST = 'ff8d9819fc0e12bf0d24892e45987e249a28dce836a85cad60e28eaaa8c6d976'
  const US_PHONE_DIGEST = '061935890870bd75f1ec8ec5a9930071c05562d3ad9453b6f5ff8eb4a51f5287'
  const UK_PHONE_DIGEST = '8d5f937f3a5590634cbe975951a6aa1543170671ce6e73cce4062f4e8c288417'

  it('hashes an email exactly as the vendor does, unsalted', () => {
    expect(hasher.matchKey('alice@example.com', 'email')).toBe(EMAIL_DIGEST)
    expect(EMAIL_DIGEST).toBe(createHash('sha256').update('alice@example.com').digest('hex'))
  })

  it('normalises case and surrounding whitespace before hashing', () => {
    expect(hasher.matchKey('  Alice@Example.COM  ', 'email')).toBe(EMAIL_DIGEST)
  })

  it('does not fold a plus tag or dots, which the vendor does not either', () => {
    expect(hasher.matchKey('a.lice+shop@example.com', 'email')).not.toBe(EMAIL_DIGEST)
  })

  it('reduces a printed phone number to digits with its country code', () => {
    expect(normalizeForMatchKey('+1 (650) 555-5555', 'phone')).toBe('16505555555')
    expect(hasher.matchKey('+1 (650) 555-5555', 'phone')).toBe(US_PHONE_DIGEST)
    expect(hasher.matchKey('1-650-555-5555', 'phone')).toBe(US_PHONE_DIGEST)
  })

  it('drops a national trunk prefix, which is formatting rather than number', () => {
    expect(normalizeForMatchKey('0044 20 7183 8750', 'phone')).toBe('442071838750')
    expect(hasher.matchKey('0044 20 7183 8750', 'phone')).toBe(UK_PHONE_DIGEST)
  })

  it('is the same digest the vendor computes on its own side, by construction', () => {
    expect(US_PHONE_DIGEST).toBe(createHash('sha256').update('16505555555').digest('hex'))
  })

  it('refuses a value it cannot put into the format', () => {
    expect(hasher.matchKey('not a phone', 'phone')).toBeNull()
    expect(hasher.matchKey('   ', 'email')).toBeNull()
  })

  it('is not the pseudonym of the same value', () => {
    expect(hasher.matchKey('alice@example.com', 'email')).not.toBe(
      hasher.pseudonymize('alice@example.com'),
    )
  })
})

describe('applyHash', () => {
  it('reports the mode it applied', () => {
    const obj = { em: 'alice@example.com' }
    expect(applyHash(obj, 'em', hasher, { mode: 'match_key', normalize: 'email' })).toEqual({
      action: 'hash',
      mode: 'match_key',
    })

    const other = { user_id: 'alice@example.com' }
    expect(applyHash(other, 'user_id', hasher, { mode: 'pseudonymize' })).toEqual({
      action: 'hash',
      mode: 'pseudonymize',
    })
    expect(other.user_id).not.toBe(obj.em)
  })

  it('removes a declared match key whose value will not normalise', () => {
    const obj = { ph: 'call me' }
    expect(applyHash(obj, 'ph', hasher, { mode: 'match_key', normalize: 'phone' })).toEqual({
      action: 'strip',
    })
    expect('ph' in obj).toBe(false)
  })

  it('leaves a value that is not a string alone', () => {
    const obj = { em: 42 }
    expect(applyHash(obj, 'em', hasher, { mode: 'pseudonymize' })).toBeNull()
    expect(obj.em).toBe(42)
  })
})

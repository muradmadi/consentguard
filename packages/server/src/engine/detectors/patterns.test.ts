import { describe, it, expect } from 'vitest'
import { DETECTORS, DEFAULT_DETECTORS, resolveDetectors } from './patterns'

/**
 * The detector definitions themselves, and the conservatism their own comments
 * claim. "A bare run of digits is an order id far more often than a phone
 * number" is a promise about analytics data surviving the firewall, and a
 * pattern widened by accident breaks it silently — a false positive corrupts
 * the event rather than failing, which is how a firewall gets switched off.
 */
const detector = (id: string) => DETECTORS.find((d) => d.id === id)!

/** What the scanner does per value: match, then apply the second gate. */
function fires(id: string, value: string): boolean {
  const d = detector(id)
  d.pattern.lastIndex = 0
  return [...value.matchAll(d.pattern)].some((m) => !d.validate || d.validate(m[0]))
}

describe('resolveDetectors', () => {
  it('returns the definitions for the ids it is given, in declaration order', () => {
    expect(resolveDetectors(['credit_card', 'email']).map((d) => d.id)).toEqual([
      'email',
      'credit_card',
    ])
  })

  it('returns nothing for an empty set, which is how the scan is disabled', () => {
    expect(resolveDetectors([])).toEqual([])
  })

  it('leaves us_ssn out of the default set', () => {
    expect(DEFAULT_DETECTORS).not.toContain('us_ssn')
    expect(DETECTORS.map((d) => d.id)).toContain('us_ssn')
  })
})

describe('phone is conservative about separators', () => {
  it('matches E.164 and real separated forms', () => {
    for (const v of ['+14155550100', '(415) 555-0100', '415-555-0100', '415.555.0100']) {
      expect(fires('phone', v), v).toBe(true)
    }
  })

  it('does not match a bare run of digits, which is an order id', () => {
    for (const v of ['14155550100', '4155550100', '40318842']) {
      expect(fires('phone', v), v).toBe(false)
    }
  })
})

describe('credit_card needs an issuer prefix and Luhn, not just length', () => {
  it('matches real card numbers, spaced or not', () => {
    for (const v of [
      '4111111111111111',
      '4111 1111 1111 1111',
      '5555555555554444',
      '378282246310005',
    ]) {
      expect(fires('credit_card', v), v).toBe(true)
    }
  })

  it('rejects the same number with one digit changed', () => {
    expect(fires('credit_card', '4111111111111112')).toBe(false)
  })

  /**
   * The reason scanning numeric values is safe: no issuer prefix begins with a
   * 1, so a millisecond or microsecond timestamp cannot match however the Luhn
   * digits fall.
   */
  it('cannot match a timestamp, whatever its check digits', () => {
    for (const v of ['1755950400000', '1755950400000000', '1234567890123456']) {
      expect(fires('credit_card', v), v).toBe(false)
    }
  })

  it('does not match a digit run too short to be a card', () => {
    expect(fires('credit_card', '411111111111')).toBe(false)
  })
})

describe('the address detectors need their punctuation', () => {
  it('matches an ipv4 address but not a version string', () => {
    expect(fires('ipv4', '203.0.113.9')).toBe(true)
    expect(fires('ipv4', '999.999.999.999')).toBe(false)
  })

  it('matches an ipv6 address', () => {
    expect(fires('ipv6', '2001:db8::8a2e:370:7334')).toBe(true)
  })

  it('matches an email but not a bare domain', () => {
    expect(fires('email', 'alice@example.com')).toBe(true)
    expect(fires('email', 'example.com')).toBe(false)
  })

  it('needs hyphens for an SSN, so a nine-digit id is not one', () => {
    expect(fires('us_ssn', '123-45-6789')).toBe(true)
    expect(fires('us_ssn', '123456789')).toBe(false)
  })
})

/**
 * The actions are policy, not implementation detail: an address is removed
 * because a hash of it is still a stable household identifier, and a card is
 * removed because the search space is small enough that a hash is the number.
 * An email or a phone is hashed so that one person still counts as one person.
 */
describe('detector actions', () => {
  it('hashes what identity resolution needs and removes what it does not', () => {
    expect(detector('email').action).toBe('hash')
    expect(detector('phone').action).toBe('hash')
    expect(detector('ipv4').action).toBe('strip')
    expect(detector('ipv6').action).toBe('strip')
    expect(detector('credit_card').action).toBe('strip')
    expect(detector('us_ssn').action).toBe('strip')
  })
})

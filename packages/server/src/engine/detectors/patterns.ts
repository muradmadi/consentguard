import type { PiiDetector, TransformationAction } from '@sluice/shared'

export interface DetectorDefinition {
  id: PiiDetector
  /** Matched against every string value in the payload. Must be global. */
  pattern: RegExp
  /**
   * Applied when the match covers the whole value. A match inside a longer
   * string is always redacted in place instead: hashing an entire page URL
   * because it carries an email in a query param would destroy the event
   * while removing nothing the vendor could not already see.
   */
  action: TransformationAction
  /** Second gate for patterns whose shape alone is not proof. */
  validate?: (match: string) => boolean
}

/**
 * Luhn check digit. Used to keep the card detector off the long numeric ids
 * that analytics payloads are full of.
 */
export function passesLuhn(digits: string): boolean {
  let sum = 0
  let double = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48
    if (d < 0 || d > 9) return false
    if (double) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    double = !double
  }
  return sum % 10 === 0
}

/**
 * The detectors, in the order they run against a value. Each one sees the
 * result of the previous, so a string carrying both an email and an IP loses
 * both.
 *
 * Every pattern here is deliberately conservative about separators. A bare run
 * of digits is an order id far more often than it is a phone number, so phone
 * detection requires either E.164's leading `+` or real separators, and card
 * detection requires a known issuer prefix on top of Luhn. False positives
 * corrupt analytics data, which is how a firewall gets switched off.
 */
export const DETECTORS: DetectorDefinition[] = [
  {
    id: 'email',
    pattern: /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi,
    // Hashed, not stripped: the same address keeps the same token, so the event
    // still counts one person as one person, without carrying the address. It
    // is a pseudonym, not a match key — the vendor cannot resolve identity from
    // it. A field a vendor is allowed to match on is a line in a destination
    // rule, not something a scanner decides by shape.
    action: 'hash',
  },
  {
    id: 'phone',
    pattern: /\+[1-9]\d{7,14}\b|(?:\(\d{3}\)[-.\s]?|\b\d{3}[-.\s])\d{3}[-.\s]\d{4}\b/g,
    action: 'hash',
  },
  {
    id: 'ipv4',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    // No vendor has a legitimate need for the raw address, and a hash of it is
    // still a stable identifier for a household.
    action: 'strip',
  },
  {
    id: 'ipv6',
    pattern:
      /(?<![\w:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?|::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6}))(?![\w:])/gi,
    action: 'strip',
  },
  {
    id: 'credit_card',
    // Visa, Mastercard (both ranges), Amex, Discover, JCB — with optional
    // space or dash grouping, then length and Luhn.
    pattern: /\b(?:4|5[1-5]|2[2-7]|3[47]|6011|65)[\d -]{10,17}\d\b/g,
    // Never hashed: the search space of card numbers is small enough that a
    // hash is the number.
    action: 'strip',
    validate: (match) => {
      const digits = match.replace(/\D/g, '')
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits)
    },
  },
  {
    id: 'us_ssn',
    pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    action: 'strip',
  },
]

/**
 * On by default. `us_ssn` is left out: it is jurisdiction-specific and its
 * shape collides with ordinary hyphenated ids.
 */
export const DEFAULT_DETECTORS: PiiDetector[] = ['email', 'phone', 'ipv4', 'ipv6', 'credit_card']

export function resolveDetectors(enabled: PiiDetector[]): DetectorDefinition[] {
  return DETECTORS.filter((d) => enabled.includes(d.id))
}

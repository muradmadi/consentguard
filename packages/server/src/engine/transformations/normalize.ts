import type { NormalizeFormat } from '@sluice/shared'

/**
 * Put a value into the form the vendor hashes on its own side.
 *
 * A match key is only worth the weaker disclosure if it actually matches, and
 * every vendor that accepts one specifies the normalisation first: Meta's
 * Conversions API and Google's Enhanced Conversions both hash a canonical form,
 * so `Alice@Example.com ` and `alice@example.com` have to arrive as the same
 * digest. Getting this wrong fails silently — the digest is well-formed, the
 * event is accepted, and it matches nobody.
 *
 * Returns an empty string when the value cannot be put into the format at all.
 * Callers treat that as a value to remove rather than to hash: the digest of an
 * empty string is a constant that would read as a real match key.
 */
export function normalizeForMatchKey(value: string, format: NormalizeFormat): string {
  switch (format) {
    case 'email':
      // Trim, lowercase, nothing else. Provider-specific folding — dropping the
      // dots in a Gmail local part, cutting a `+` tag — is not what the vendor
      // does, so doing it here would move the digest away from theirs.
      return value.trim().toLowerCase()
    case 'phone':
      return normalizePhone(value)
  }
}

/**
 * Digits only, leading zeros removed, country code kept.
 *
 * A national trunk prefix (`0` in most of Europe) and the `+`, spaces, dashes
 * and parentheses of a printed number are all formatting; the vendor strips them
 * before hashing. A number that arrives without a country code cannot be
 * repaired here — inventing one would produce a digest for a different person —
 * so it is normalised as given and simply will not match.
 */
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '').replace(/^0+/, '')
  // Shorter than the shortest national number in the ITU plan: not a phone
  // number, whatever matched.
  return digits.length < 7 ? '' : digits
}

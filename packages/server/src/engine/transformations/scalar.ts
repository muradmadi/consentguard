/**
 * The values a transformation can act on, and the one place that rule is stated.
 *
 * A transformation used to require `typeof value === 'string'`, which made the
 * firewall's protection depend on a payload's JSON types. It is not a boundary
 * any vendor treats as one: GA4, Amplitude and Mixpanel all accept `user_id` as
 * a number, and all three of their rules declare it for hashing. A numeric one
 * passed through unhashed, and — because the audit is derived from what fired —
 * the record said nothing had fired, which is true and reads as a dead rule
 * path rather than as an identifier leaving in the clear.
 *
 * A number is a scalar carrying a value, so it is transformed as its decimal
 * text. A boolean is not an identifier and hashing one says nothing that the
 * two possible digests do not already say. An object or an array is a rule
 * pointing at a container rather than at a field, which is a mistake in the
 * rule: leaving it as `matched: 0` keeps it visible in rule health instead of
 * quietly hashing a JSON blob.
 */
export function asScalarText(value: unknown): string | null {
  if (typeof value === 'string') return value
  // Number, not Number.isFinite: NaN and Infinity serialise to `null` in JSON
  // and carry nothing to protect.
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'bigint') return String(value)
  return null
}

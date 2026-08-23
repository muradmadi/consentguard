import { asScalarText } from './scalar'

/**
 * Redact transformation: replaces sensitive values with [REDACTED] or a partial mask.
 * Returns true only if the value actually changed — a pattern that matches
 * nothing is not a transformation that fired.
 */
export const applyRedact = (obj: any, head: string, pattern?: string): boolean => {
  if (!obj || typeof obj !== 'object') return false

  // A number is redacted as its decimal text; see `asScalarText`.
  const before = asScalarText(obj[head])
  if (before === null) return false

  let after: string

  if (pattern) {
    try {
      after = before.replace(new RegExp(pattern, 'gi'), '[REDACTED]')
    } catch (e) {
      // A pattern that will not compile is a rule that cannot be evaluated, and
      // an un-evaluated rule is not a reason to forward the value it was written
      // to remove. Redact the whole field.
      console.warn(`[Sluice] Invalid regex pattern for redaction: ${pattern}`, e)
      after = '[REDACTED]'
    }
  } else {
    after = '[REDACTED]'
  }

  // Assigned only on a real change. Writing the value back unconditionally would
  // retype a number to its decimal text on a pattern that matched nothing —
  // editing the payload while truthfully reporting that no transformation fired.
  if (after === before) return false

  obj[head] = after
  return true
}

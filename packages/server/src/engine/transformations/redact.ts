/**
 * Redact transformation: replaces sensitive values with [REDACTED] or a partial mask.
 * Returns true only if the value actually changed — a pattern that matches
 * nothing is not a transformation that fired.
 */
export const applyRedact = (obj: any, head: string, pattern?: string): boolean => {
  if (!obj || typeof obj !== 'object' || typeof obj[head] !== 'string') return false

  const before = obj[head]

  if (pattern) {
    try {
      obj[head] = before.replace(new RegExp(pattern, 'gi'), '[REDACTED]')
    } catch (e) {
      console.warn(`[Sluice] Invalid regex pattern for redaction: ${pattern}`, e)
      obj[head] = '[REDACTED]'
    }
  } else {
    obj[head] = '[REDACTED]'
  }

  return obj[head] !== before
}

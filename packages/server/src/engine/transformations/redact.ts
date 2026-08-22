/**
 * Redact transformation: replaces sensitive values with [REDACTED] or a partial mask.
 */
export const applyRedact = (obj: any, head: string, pattern?: string) => {
  if (obj && typeof obj === 'object' && typeof obj[head] === 'string') {
    if (pattern) {
      try {
        const regex = new RegExp(pattern, 'gi');
        obj[head] = obj[head].replace(regex, '[REDACTED]');
      } catch (e) {
        console.warn(`[Sluice] Invalid regex pattern for redaction: ${pattern}`);
        obj[head] = '[REDACTED]';
      }
    } else {
      obj[head] = '[REDACTED]';
    }
  }
};

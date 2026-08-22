/**
 * Strip transformation: removes a field from the payload.
 * Returns true if the field was present and removed.
 */
export const applyStrip = (obj: any, head: string): boolean => {
  if (obj && typeof obj === 'object' && head in obj) {
    delete obj[head]
    return true
  }
  return false
}

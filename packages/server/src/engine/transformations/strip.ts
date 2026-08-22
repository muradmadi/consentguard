/**
 * Strip transformation: removes a field from the payload.
 */
export const applyStrip = (obj: any, head: string) => {
  if (obj && typeof obj === 'object' && head in obj) {
    delete obj[head]
  }
}

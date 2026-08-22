/**
 * Where the admin bearer lives in the browser.
 *
 * It used to be `import.meta.env.VITE_ADMIN_SECRET`, which Vite inlines at
 * build time — so the token was a string literal inside a bundle the proxy
 * serves unauthenticated at /dashboard/*. Anyone who opened the dashboard could
 * read the credential for /audit, /api/rules and /api/debug/reset out of the
 * JavaScript.
 *
 * The operator types it in instead. Session storage keeps it to the one tab and
 * drops it when that tab closes, and nothing about it survives into a build
 * artifact.
 */
const STORAGE_KEY = 'sluice_admin_token'

export function getToken(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) || ''
  } catch {
    // Private mode, or a browser with site data switched off. The operator can
    // still work; they just re-enter the token on each load.
    return ''
  }
}

export function setToken(token: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, token)
  } catch {
    /* see getToken */
  }
}

export function clearToken(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* see getToken */
  }
}

/**
 * Registry of patterns to intercept.
 * Maps domain patterns to destination IDs.
 *
 * Every id here must exist in the server's destination registry, and every
 * endpoint a rule declares must be matched by some pattern here. Both halves
 * are asserted by packages/server/src/destinations/patterns.test.ts.
 */
export const INTERCEPTION_PATTERNS: Record<string, string> = {
  'google-analytics.com': 'ga4',
  'analytics.google.com': 'ga4',
  'api.mixpanel.com': 'mixpanel',
  'amplitude.com': 'amplitude',
  // facebook.net is the script CDN and carries no payload; it is matched so the
  // mutation observer can defuse the pixel loader. facebook.com/tr is the beacon.
  'facebook.net': 'facebook_pixel',
  'facebook.com/tr': 'facebook_pixel',
  'tiktok.com': 'tiktok',
  'hotjar.com': 'hotjar',
}

/**
 * Registry of patterns to intercept.
 * Maps domain patterns to destination IDs.
 */
export const INTERCEPTION_PATTERNS: Record<string, string> = {
  'google-analytics.com': 'ga4',
  'api.mixpanel.com': 'mixpanel',
  'segment.io': 'segment',
  'amplitude.com': 'amplitude',
  'facebook.net': 'facebook_pixel',
};

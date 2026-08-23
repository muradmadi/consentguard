/**
 * Registry of patterns to intercept, and the matcher both halves of the
 * contract use.
 *
 * A pattern is `host` or `host/pathPrefix`. Every id here must exist in the
 * server's destination registry, and every endpoint a rule declares must be
 * matched by some pattern here. Both halves are asserted by
 * packages/server/src/destinations/patterns.test.ts, which imports
 * `matchDestination` from this file so the guard tests the real matcher rather
 * than a reimplementation of it.
 */
export const INTERCEPTION_PATTERNS: Record<string, string> = {
  'google-analytics.com': 'ga4',
  'analytics.google.com': 'ga4',
  // mixpanel.com rather than api.mixpanel.com: the JS SDK posts to
  // api-js.mixpanel.com, which the narrower pattern never matched.
  'mixpanel.com': 'mixpanel',
  'amplitude.com': 'amplitude',
  // facebook.net is the script CDN and carries no payload; it is matched so the
  // mutation observer can defuse the pixel loader. facebook.com/tr is the beacon.
  'facebook.net': 'facebook_pixel',
  'facebook.com/tr': 'facebook_pixel',
  'tiktok.com': 'tiktok',
  'hotjar.com': 'hotjar',
  'hotjar.io': 'hotjar',
}

/**
 * Which destination, if any, a URL belongs to.
 *
 * This used to be `url.includes(domain)` against the whole URL. That matched
 * the query string as readily as the host, so `https://app.example.com/?ref=
 * amplitude.com` was rerouted into the firewall, and it matched a suffix of a
 * longer name, so `notamplitude.com` counted as `amplitude.com`. Rerouting
 * first-party application traffic into an analytics proxy is a way to lose it.
 *
 * Matching now parses the URL and reads the host, under the same subdomain rule
 * the server applies in `engine/egress.ts`: a declared domain covers itself and
 * its subdomains and nothing else. A pattern's optional path prefix has to match
 * a whole segment, so `facebook.com/tr` does not claim `/track`.
 */
export function matchDestination(url: string, destinations: Record<string, string>): string | null {
  let parsed: URL
  try {
    // Relative URLs are first-party by definition, and `new URL` rejects them
    // without a base — so a parse failure is already the right answer.
    parsed = new URL(url)
  } catch {
    return null
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null

  const host = parsed.hostname.toLowerCase()

  for (const [pattern, id] of Object.entries(destinations)) {
    const slash = pattern.indexOf('/')
    const patternHost = (slash === -1 ? pattern : pattern.slice(0, slash)).toLowerCase()
    if (host !== patternHost && !host.endsWith(`.${patternHost}`)) continue

    if (slash !== -1) {
      const prefix = `/${pattern.slice(slash + 1).replace(/^\/+|\/+$/g, '')}`
      const path = parsed.pathname
      if (path !== prefix && !path.startsWith(`${prefix}/`)) continue
    }

    return id
  }

  return null
}

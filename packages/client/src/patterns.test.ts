import { describe, it, expect } from 'vitest'
import { INTERCEPTION_PATTERNS, matchDestination } from './patterns'

/**
 * The matcher's own semantics, tested in the package that owns it.
 *
 * These assertions used to live in the server's drift guard, because that is
 * where they were written. The guard's job is the cross-package contract — that
 * the table and the registry agree — and it belongs there; what a host pattern
 * means is this file's business, and a change to it should fail here rather
 * than in a suite `just watch client` never runs and the server's `typecheck`
 * excludes.
 *
 * Matching used to be `url.includes(domain)` against the whole URL, so a
 * first-party request naming a vendor anywhere in its query string was quietly
 * rerouted into the firewall, and any longer name ending in a declared one
 * matched it. Losing real application traffic to an analytics proxy is the
 * expensive half of that.
 */
const match = (url: string) => matchDestination(url, INTERCEPTION_PATTERNS)

describe('lookalikes and near misses', () => {
  it('does not match a host that merely ends with a declared name', () => {
    expect(match('https://notamplitude.com/api')).toBeNull()
  })

  it('does not match a declared name used as a prefix of a longer host', () => {
    expect(match('https://facebook.com.evil.test/tr')).toBeNull()
  })

  it('does not match a first-party URL that names a vendor in its query string', () => {
    expect(match('https://app.example.com/?ref=amplitude.com')).toBeNull()
  })

  it('does not match a vendor named in the path of another host', () => {
    expect(match('https://cdn.example.com/mixpanel.com/shim.js')).toBeNull()
  })

  it('does not let a path prefix match a longer first segment', () => {
    // facebook.com/tr is the beacon; /track is somebody else's endpoint.
    expect(match('https://www.facebook.com/track?x=1')).toBeNull()
  })

  it('still matches the beacon path and anything under it', () => {
    expect(match('https://www.facebook.com/tr?id=1&ev=PageView')).toBe('facebook_pixel')
    expect(match('https://www.facebook.com/tr/')).toBe('facebook_pixel')
  })

  it('matches a subdomain of a declared host', () => {
    expect(match('https://api-js.mixpanel.com/track/')).toBe('mixpanel')
    expect(match('https://api2.amplitude.com/2/httpapi')).toBe('amplitude')
  })

  it('ignores anything that is not an absolute http(s) URL', () => {
    expect(match('/analytics/ingest/ga4')).toBeNull()
    expect(match('data:image/gif;base64,R0lGOD')).toBeNull()
    expect(match('not a url')).toBeNull()
  })
})

/**
 * A caller may pass its own table through `ClientConfig.destinations`, so the
 * matcher has to be correct against a table it did not ship with. The built-in
 * one happens to contain no bare-host entry that is also a path-prefix entry.
 */
describe('a caller-supplied table', () => {
  const custom = { 'vendor.test': 'vendor', 'shared.test/beacon': 'shared_beacon' }

  it('matches an entry the built-in table does not contain', () => {
    expect(matchDestination('https://vendor.test/collect', custom)).toBe('vendor')
  })

  it('leaves a host the caller did not list alone', () => {
    expect(matchDestination('https://other.test/collect', custom)).toBeNull()
  })

  it('applies the same whole-segment rule to a caller path prefix', () => {
    expect(matchDestination('https://shared.test/beacon', custom)).toBe('shared_beacon')
    expect(matchDestination('https://shared.test/beacons', custom)).toBeNull()
  })
})

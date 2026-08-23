import { describe, it, expect } from 'vitest'
import { INTERCEPTION_PATTERNS, matchDestination } from '../../../client/src/patterns'
import { REGISTRY_KEYS, getDestinationRule } from './registry'

/**
 * The client's interception table and the server's registry are two halves of
 * one contract: the client decides what to reroute and under which destination
 * id, the server decides what that id means. They live in different packages
 * and had drifted — the table named a destination the registry never had, and
 * missed beacon hosts the rules themselves declare. Convention did not hold
 * them together, so the gate does.
 *
 * The coverage assertion runs the real `matchDestination`, not a substring
 * test standing in for it, because the matcher is the thing that drifted.
 */
const match = (url: string) => matchDestination(url, INTERCEPTION_PATTERNS)

/** A declared endpoint is a host pattern; make it the URL a beacon would use. */
const asUrl = (endpoint: string) => `https://${endpoint.replace(/\/$/, '')}/`

describe('client interception patterns', () => {
  it('never names a destination the registry cannot serve', () => {
    for (const [pattern, id] of Object.entries(INTERCEPTION_PATTERNS)) {
      expect(REGISTRY_KEYS, `pattern "${pattern}" routes to unknown destination "${id}"`).toContain(
        id,
      )
    }
  })

  it('intercepts every endpoint a destination rule declares, under that rule', () => {
    for (const id of REGISTRY_KEYS) {
      const rule = getDestinationRule(id)!
      for (const endpoint of rule.endpoints) {
        expect(match(asUrl(endpoint)), `endpoint "${endpoint}" of "${id}"`).toBe(id)
      }
    }
  })
})

/**
 * Matching used to be `url.includes(domain)` against the whole URL, so a
 * first-party request naming a vendor anywhere in its query string was quietly
 * rerouted into the firewall, and any longer name ending in a declared one
 * matched it. Losing real application traffic to an analytics proxy is the
 * expensive half of that.
 */
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

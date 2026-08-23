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
 *
 * Only the cross-package contract lives here. What a host pattern means is the
 * matcher's own business and is asserted in `client/src/patterns.test.ts`,
 * which the client package actually runs — this file imports across a package
 * boundary and is excluded from the server's `typecheck` for it.
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

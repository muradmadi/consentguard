import { describe, it, expect } from 'vitest'
import { INTERCEPTION_PATTERNS } from '../../../client/src/patterns'
import { REGISTRY_KEYS, getDestinationRule } from './registry'

/**
 * The client's interception table and the server's registry are two halves of
 * one contract: the client decides what to reroute and under which destination
 * id, the server decides what that id means. They live in different packages
 * and had drifted — the table named a destination the registry never had, and
 * missed beacon hosts the rules themselves declare. Convention did not hold
 * them together, so the gate does.
 */
describe('client interception patterns', () => {
  it('never names a destination the registry cannot serve', () => {
    for (const [pattern, id] of Object.entries(INTERCEPTION_PATTERNS)) {
      expect(REGISTRY_KEYS, `pattern "${pattern}" routes to unknown destination "${id}"`).toContain(
        id,
      )
    }
  })

  it('intercepts every endpoint a destination rule declares', () => {
    const patterns = Object.keys(INTERCEPTION_PATTERNS)

    for (const id of REGISTRY_KEYS) {
      const rule = getDestinationRule(id)!
      for (const endpoint of rule.endpoints) {
        const covered = patterns.some((pattern) => endpoint.includes(pattern))
        expect(covered, `no pattern intercepts "${endpoint}" for destination "${id}"`).toBe(true)
      }
    }
  })
})

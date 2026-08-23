import { describe, it, expect } from 'vitest'
import type { DestinationRule } from '@sluice/shared'
import { supportFor, withSupport } from './support'
import { REGISTRY_KEYS, getDestinationRule, getDefaultRule } from './registry'
import { ADAPTER_IDS } from './adapters'

const rule = (over: Partial<DestinationRule> = {}): DestinationRule => ({
  id: 'nobody',
  category: 'analytics',
  endpoints: ['vendor.test'],
  transport: 'json',
  transformations: [],
  ...over,
})

describe('supportFor', () => {
  it('reports adapter for every destination that has one registered', () => {
    for (const id of ADAPTER_IDS) {
      expect(supportFor(getDestinationRule(id)!), id).toBe('adapter')
    }
  })

  it('reports adapter even for an opaque transport, because that is what an adapter is for', () => {
    // mixpanel is the case: base64 payload, unusable without decoding.
    expect(supportFor(rule({ id: 'mixpanel', transport: 'opaque' }))).toBe('adapter')
  })

  it('reports passthrough for a transport both scrub passes can read', () => {
    expect(supportFor(rule({ transport: 'json' }))).toBe('passthrough')
    expect(supportFor(rule({ transport: 'pixel' }))).toBe('passthrough')
  })

  it('reports unsupported for an encoded payload with nothing to decode it', () => {
    expect(supportFor(rule({ transport: 'opaque' }))).toBe('unsupported')
  })

  it('refuses a destination nobody declared', () => {
    expect(supportFor(getDefaultRule('never-heard-of-it'))).toBe('unsupported')
  })

  it('attaches the level without disturbing the rule', () => {
    const base = rule()
    expect(withSupport(base)).toEqual({ ...base, support: 'passthrough' })
  })
})

/**
 * The claim this slice is judged against: nothing in the registry states
 * support it does not have. Every entry is one of the three, derived, and the
 * ones that cannot be served are refused rather than quietly passed through.
 */
describe('the registry is honest about every destination', () => {
  it.each(REGISTRY_KEYS)('%s declares a transport and derives a level', (id) => {
    const declared = getDestinationRule(id)!
    expect(['pixel', 'json', 'opaque']).toContain(declared.transport)
    expect(['adapter', 'passthrough', 'unsupported']).toContain(supportFor(declared))
  })

  it('never leaves an opaque destination on the passthrough path', () => {
    for (const id of REGISTRY_KEYS) {
      const declared = getDestinationRule(id)!
      if (declared.transport !== 'opaque') continue
      expect(supportFor(declared), `${id} would forward a payload it cannot read`).not.toBe(
        'passthrough',
      )
    }
  })

  it('has no rule left carrying an unusable upstream template', () => {
    for (const id of REGISTRY_KEYS) {
      const { upstreamUrl } = getDestinationRule(id)!
      if (!upstreamUrl) continue
      expect(upstreamUrl, id).not.toMatch(/[<>{}]/)
      expect(() => new URL(upstreamUrl), id).not.toThrow()
    }
  })
})

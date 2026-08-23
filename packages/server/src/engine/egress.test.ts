import { describe, it, expect } from 'vitest'
import type { DestinationRule } from '@sluice/shared'
import { checkEgress, declaredHosts } from './egress'

const rule = (over: Partial<DestinationRule> = {}): DestinationRule => ({
  id: 'test',
  category: 'marketing',
  endpoints: ['vendor.test', 'other.test/tr'],
  transport: 'json',
  transformations: [],
  ...over,
})

function reason(url: string, r: DestinationRule = rule()): string | null {
  const verdict = checkEgress(url, r)
  return verdict.ok ? null : verdict.reason
}

describe('declaredHosts', () => {
  it('takes the domain half of an endpoint that carries a path', () => {
    expect(declaredHosts(rule())).toEqual(['vendor.test', 'other.test'])
  })

  it('includes wherever the rule says to forward', () => {
    expect(declaredHosts(rule({ upstreamUrl: 'https://api.upstream.test/v1/events' }))).toContain(
      'api.upstream.test',
    )
  })

  it('declares nothing from an upstreamUrl that is not a URL', () => {
    expect(declaredHosts(rule({ endpoints: [], upstreamUrl: 'not a url' }))).toEqual([])
  })
})

describe('checkEgress', () => {
  it('allows a declared host', () => {
    expect(reason('https://vendor.test/collect?e=1')).toBeNull()
  })

  it('allows a subdomain of a declared host', () => {
    expect(reason('https://graph.vendor.test/v17.0/events')).toBeNull()
  })

  it('allows the path to differ from the one an endpoint names', () => {
    expect(reason('https://other.test/some/other/api')).toBeNull()
  })

  it('allows the rule’s own upstreamUrl', () => {
    const r = rule({ endpoints: [], upstreamUrl: 'https://api.upstream.test/v1/events' })
    expect(reason('https://api.upstream.test/v1/events', r)).toBeNull()
  })

  it('refuses a host nothing declared', () => {
    expect(reason('https://attacker.test/pwned')).toBe('host_not_declared')
  })

  it('refuses a host that merely ends with a declared name', () => {
    expect(reason('https://notvendor.test/x')).toBe('host_not_declared')
  })

  it('refuses a declared name used as a subdomain of somewhere else', () => {
    expect(reason('https://vendor.test.attacker.test/x')).toBe('host_not_declared')
  })

  it('refuses a declared name smuggled through userinfo', () => {
    expect(reason('https://vendor.test@attacker.test/x')).toBe('host_not_declared')
  })

  it('refuses a declared name that only appears in the query string', () => {
    expect(reason('https://attacker.test/x?host=vendor.test')).toBe('host_not_declared')
  })

  it('refuses a URL it cannot parse', () => {
    expect(reason('vendor.test/collect')).toBe('unparseable_forward_url')
  })

  it.each(['file:///etc/passwd', 'gopher://vendor.test/', 'data:text/plain,x'])(
    'refuses the scheme in %s',
    (url) => {
      expect(reason(url)).not.toBeNull()
    },
  )

  /**
   * Checked ahead of the allowlist, so a rule that declares an internal address
   * — whether an operator wrote it or a rule override put it there — cannot
   * reach one either.
   */
  describe('internal addresses', () => {
    const internal = rule({ endpoints: [] })

    it.each([
      'http://127.0.0.1:4111/pwned',
      'http://127.255.255.254/',
      'http://0.0.0.0/',
      'http://10.1.2.3/admin',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://100.100.100.200/',
      'http://[::1]:9200/',
      'http://[fd00::1]/',
      'http://[fe80::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://localhost:8080/',
      'http://redis.localhost/',
      'http://db.internal:5432/',
      'http://printer.local/',
    ])('refuses %s even when declared', (url) => {
      const host = new URL(url).hostname
      const declared = rule({ endpoints: [host.replace(/^\[|\]$/g, '')] })
      expect(reason(url, declared)).toBe('host_is_internal_address')
      expect(reason(url, internal)).toBe('host_is_internal_address')
    })

    it('does not mistake a routable address for an internal one', () => {
      expect(reason('https://93.184.216.34/x', rule({ endpoints: ['93.184.216.34'] }))).toBeNull()
      expect(reason('https://172.32.0.1/x', rule({ endpoints: ['172.32.0.1'] }))).toBeNull()
    })
  })

  /**
   * The default rule for an unknown destination declares no endpoints and no
   * upstream, so it can forward nowhere. Fail closed.
   */
  it('allows nothing for a rule that declares nothing', () => {
    expect(reason('https://vendor.test/x', rule({ endpoints: [] }))).toBe('host_not_declared')
  })
})

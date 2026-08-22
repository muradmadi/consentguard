import type { DestinationRule } from '@sluice/shared'

export type EgressVerdict = { ok: true } | { ok: false; reason: string }

/**
 * Decide whether the firewall is allowed to make this outbound call.
 *
 * `?original=` and the `X-Original-Url` header are attacker-controlled: the
 * browser names the URL it was heading to, and the proxy forwards there. With
 * nothing checking that name, any URL the server can route to was reachable by
 * anyone who could reach `/ingest` — cloud metadata endpoints and internal
 * admin panels included — and the audit recorded it as a clean forward to the
 * vendor. The response never comes back to the caller, so it is a blind
 * exfiltration and internal-scanning primitive rather than a read.
 *
 * The rule is the authority on where its destination may talk to. A forward's
 * host must match an endpoint the destination rule declares (or the host of its
 * own `upstreamUrl`, which the rule declares just as explicitly). Everything
 * else is refused and audited: a refusal is evidence too.
 */
export function checkEgress(url: string, rule: DestinationRule): EgressVerdict {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'unparseable_forward_url' }
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'unsupported_forward_scheme' }
  }

  // Hostname, not the URL string: `https://vendor.test@127.0.0.1/` and
  // `https://evil.test/?x=vendor.test` both contain a declared domain as a
  // substring while addressing something else entirely.
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  // Checked before the allowlist, so a rule that declares an internal address —
  // whether an operator wrote it or a rule override put it there — still cannot
  // reach one.
  if (isInternalHost(host)) return { ok: false, reason: 'host_is_internal_address' }

  if (!declaredHosts(rule).some((pattern) => matchesHost(host, pattern))) {
    return { ok: false, reason: 'host_not_declared' }
  }

  return { ok: true }
}

/**
 * The hosts a rule declares: its interception endpoints plus wherever its
 * `upstreamUrl` points.
 *
 * An endpoint is a domain pattern, sometimes with a path (`facebook.com/tr`).
 * Only the domain half constrains egress — the path addresses the vendor's API,
 * and an adapter legitimately calls a different one on the same host.
 */
export function declaredHosts(rule: DestinationRule): string[] {
  const hosts = rule.endpoints.map(endpointHost).filter(Boolean)

  if (rule.upstreamUrl) {
    try {
      hosts.push(new URL(rule.upstreamUrl).hostname.toLowerCase())
    } catch {
      // A malformed upstreamUrl declares nothing. It cannot be forwarded to
      // either, so there is no branch to widen here.
    }
  }

  return hosts
}

/** Strip any scheme, path, port or credentials, leaving the domain pattern. */
function endpointHost(endpoint: string): string {
  return endpoint
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .split('/')[0]
    .split(':')[0]
}

/**
 * A declared domain covers itself and its subdomains, and nothing else:
 * `facebook.com` matches `graph.facebook.com` but not `notfacebook.com` or
 * `facebook.com.evil.test`.
 */
function matchesHost(host: string, pattern: string): boolean {
  return host === pattern || host.endsWith(`.${pattern}`)
}

/**
 * Addresses that are never a vendor: loopback, private and link-local ranges,
 * the cloud metadata address, and the hostnames that conventionally resolve
 * inside a network.
 *
 * This looks at the host as written rather than resolving it. A declared vendor
 * domain that resolves to a private address still gets through — closing that
 * needs DNS on the hot path, and it is reachable only by someone who can
 * already write destination rules.
 */
function isInternalHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host.endsWith('.local') || host.endsWith('.internal')) return true

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4) return isInternalIpv4(ipv4.slice(1).map(Number))

  if (host.includes(':')) return isInternalIpv6(host)

  return false
}

function isInternalIpv4([a, b]: number[]): boolean {
  if (a === 0 || a === 127) return true // this network, loopback
  if (a === 10) return true // private
  if (a === 172 && b >= 16 && b <= 31) return true // private
  if (a === 192 && b === 168) return true // private
  if (a === 169 && b === 254) return true // link-local, incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true // carrier-grade NAT
  if (a === 192 && b === 0) return true // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true // benchmarking
  if (a >= 224) return true // multicast, reserved, broadcast
  return false
}

function isInternalIpv6(host: string): boolean {
  const address = host.toLowerCase()
  if (address === '::1' || address === '::') return true
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true // unique local
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true // link-local
  // An IPv4-mapped address is an IPv4 address wearing a hat. `URL` normalises
  // the dotted form to hextets, so ::ffff:127.0.0.1 arrives as ::ffff:7f00:1.
  const dotted = address.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (dotted) return isInternalIpv4(dotted[1].split('.').map(Number))

  const hextets = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (hextets) {
    const high = parseInt(hextets[1], 16)
    const low = parseInt(hextets[2], 16)
    return isInternalIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff])
  }

  return false
}

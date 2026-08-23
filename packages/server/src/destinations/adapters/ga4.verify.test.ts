import { describe, it, expect } from 'vitest'
import { ga4Adapter } from './ga4'
import { ga4 as ga4Rule } from '../ga4'
import { ALL_BEACONS, type Beacon } from './ga4.fixtures'
import type { VendorContext } from './types'
import { getServerConfig } from '../../config'
import { createHasher } from '../../engine/transformations/hash'

/**
 * What the firewall actually does to GA4, asserted against the beacons gtag
 * sends rather than against the rule's own declarations.
 *
 * The claim this repository is judged against is that nothing leaves carrying
 * an email, a phone number or a raw IP, and that there is a record proving it.
 * Every other suite here tests a mechanism. This one tests the sentence, for
 * one destination, end to end: beacon in, Measurement Protocol payload out.
 *
 * The limit is stated in `ga4.fixtures.ts` and worth repeating: these are the
 * wire format written out, not captures from a live browser. That verifies the
 * rule and the adapter against the documented shape, which is weaker than
 * verifying them against a recording.
 */

const ENV = {
  NODE_ENV: 'test',
  ADMIN_SECRET: 'x',
  GA4_MEASUREMENT_ID: 'G-TEST12345',
  GA4_API_SECRET: 'test-secret',
  SLUICE_HASH_SECRET: 'test-hash-secret',
}

function forward(beacon: Beacon) {
  const ctx: VendorContext = {
    method: 'POST',
    originalUrl: beacon.url,
    query: new URLSearchParams(),
    headers: beacon.contentType ? { 'content-type': beacon.contentType } : {},
    jsonBody: null,
    rawBody: beacon.body ?? '',
    rule: ga4Rule,
    serverConfig: getServerConfig(ENV),
    hasher: createHasher('test-hash-secret'),
  }
  const result = ga4Adapter.buildRequest(ctx)
  if (!result || 'skip' in result || result instanceof Promise) {
    throw new Error('expected a forward')
  }
  return { ...result, payload: JSON.parse(result.body) }
}

/** Everything that reaches Google, as one string: body and URL together. */
function everythingSent(beacon: Beacon): string {
  const built = forward(beacon)
  return `${built.url}\n${built.body}`
}

describe('no personal data reaches Google', () => {
  it.each(Object.keys(ALL_BEACONS))('carries no email address: %s', (name) => {
    expect(everythingSent(ALL_BEACONS[name])).not.toContain('alice@example.com')
  })

  it.each(Object.keys(ALL_BEACONS))('carries no phone number: %s', (name) => {
    const sent = everythingSent(ALL_BEACONS[name])
    expect(sent).not.toContain('+447700900123')
    expect(sent).not.toContain('+14155550100')
  })

  it.each(Object.keys(ALL_BEACONS))('carries no IP address: %s', (name) => {
    const sent = everythingSent(ALL_BEACONS[name])
    expect(sent).not.toContain('203.0.113.9')
    expect(sent).not.toContain('2001:db8::8a2e:370:7334')
  })

  it('carries no card number', () => {
    expect(everythingSent(ALL_BEACONS.contactDetails)).not.toContain('4111111111111111')
  })

  /**
   * The address in a page URL is the case a declared rule cannot cover, because
   * nobody declares `dl`. It is removed in place rather than by dropping the
   * field: a page URL with one bad query parameter is still the event's most
   * useful dimension.
   */
  it('removes an address from the page URL without discarding the URL', () => {
    const { payload } = forward(ALL_BEACONS.confirmationUrlCarryingEmail)
    expect(payload.events[0].params.dl).toContain('shop.example.com/welcome')
    expect(payload.events[0].params.dl).not.toContain('alice@example.com')
    expect(payload.events[0].params.dl).toContain('[REDACTED]')
  })

  it('removes an address from the page title too', () => {
    const { payload } = forward(ALL_BEACONS.confirmationUrlCarryingEmail)
    expect(payload.events[0].params.dt).not.toContain('alice@example.com')
  })
})

/**
 * The strongest privacy property this destination has, and it was never stated.
 *
 * The Measurement Protocol call is made by the proxy, so the connection Google
 * sees comes from the deployment's own address. The visitor's address is not
 * forwarded, and the only way it could be is `uip` — which the adapter never
 * sets and could not, since nothing in its output is copied from the transport.
 */
describe('the visitor is not identified by their connection', () => {
  it.each(Object.keys(ALL_BEACONS))('sends no uip parameter: %s', (name) => {
    const built = forward(ALL_BEACONS[name])
    expect(built.url).not.toContain('uip')
    expect(built.payload).not.toHaveProperty('uip')
    expect(built.payload.events[0].params).not.toHaveProperty('uip')
  })

  it('forwards no header that would carry the caller forward', () => {
    const built = forward(ALL_BEACONS.pageView)
    const headers = Object.keys(built.headers).map((h) => h.toLowerCase())
    expect(headers).not.toContain('x-forwarded-for')
    expect(headers).not.toContain('x-real-ip')
    expect(headers).toEqual(['content-type'])
  })
})

/**
 * The adapter is an allowlist, which is the reason the two properties above
 * hold so broadly, and it was implicit in the code rather than asserted. Only
 * `ep.`/`epn.` event parameters and five named context keys are copied into the
 * Measurement Protocol payload; everything else gtag sends is dropped on the
 * floor. A field nobody has considered cannot reach the vendor by default,
 * which is the opposite of how a blocklist behaves.
 */
describe('only what the adapter names is forwarded', () => {
  it('drops session, client-hint and diagnostic context', () => {
    const { payload } = forward(ALL_BEACONS.pageView)
    for (const dropped of ['sid', 'sct', 'seg', '_et', '_s', '_p', 'gtm', 'uaa', 'uab', 'uap']) {
      expect(payload.events[0].params, dropped).not.toHaveProperty(dropped)
    }
  })

  /**
   * User properties never reach Google at all. A site that puts an address in
   * `user_properties` sends it on every hit, so this is a large exposure closed
   * by the allowlist rather than by a rule — and it is closed for the fields
   * nobody thought to declare as much as for the ones they did.
   */
  it('drops user properties entirely, personal or not', () => {
    const { payload, body } = forward(ALL_BEACONS.userPropertiesCarryingPii)
    expect(body).not.toContain('alice@example.com')
    expect(body).not.toContain('447700900123')
    expect(body).not.toContain('premium')
    expect(payload.events[0].params).not.toHaveProperty('email')
    expect(payload.events[0].params).not.toHaveProperty('plan')
  })

  it('keeps the five context keys it names, and the event parameters', () => {
    const { payload } = forward(ALL_BEACONS.pageView)
    expect(payload.events[0].params).toEqual({
      dl: 'https://shop.example.com/products/kettle',
      dt: 'Kettle — Example Shop',
      dr: 'https://www.google.com/',
      ul: 'en-gb',
      sr: '1920x1080',
    })
  })

  it('preserves the event shape Measurement Protocol requires', () => {
    const { payload } = forward(ALL_BEACONS.identifiedUser)
    expect(payload.client_id).toBe('1234567890.1234567890')
    expect(payload.events).toHaveLength(1)
    expect(payload.events[0].name).toBe('purchase')
    expect(payload.events[0].params.value).toBe(49.99)
    expect(payload.events[0].params.currency).toBe('GBP')
  })
})

/**
 * A batch is three events, not one event wearing three sets of parameters.
 *
 * gtag queues events and posts them as CRLF-separated lines with the shared
 * context left in the query string. Those lines used to be parsed whole, so
 * splitting on `&` ran through the line breaks and merged everything into the
 * first event: a page_view carrying a purchase's value, and a `dl` with a
 * literal newline in it. No personal data escaped — the email still met the
 * rule — but the vendor was sent an event that never happened. In a tool whose
 * product is that its reporting is derived from what occurred, inventing an
 * event is the same defect as an audit built from a rule's declarations.
 */
describe('a batched hit stays the events it was', () => {
  it('produces one event per line, in order', () => {
    const { payload } = forward(ALL_BEACONS.batched)
    expect(payload.events.map((e: any) => e.name)).toEqual(['page_view', 'sign_up', 'purchase'])
  })

  it('keeps each event’s parameters to that event', () => {
    const { payload } = forward(ALL_BEACONS.batched)
    const [pageView, signUp, purchase] = payload.events

    expect(pageView.params).not.toHaveProperty('value')
    expect(pageView.params).not.toHaveProperty('email')
    expect(signUp.params.email).toMatch(/^[0-9a-f]{64}$/)
    expect(signUp.params).not.toHaveProperty('value')
    expect(purchase.params.value).toBe(12.5)
  })

  it('leaves no line break in a value it parsed', () => {
    const { body } = forward(ALL_BEACONS.batched)
    expect(body).not.toContain('\\r\\n')
    expect(body).not.toContain('en=sign_up')
  })

  it('gives every event the hit’s shared context', () => {
    const { payload } = forward(ALL_BEACONS.batched)
    for (const event of payload.events) {
      expect(event.params.ul).toBe('en-gb')
      expect(event.params.sr).toBe('1920x1080')
    }
  })

  it('takes the client id from the shared hit, not from a line', () => {
    const { payload } = forward(ALL_BEACONS.batched)
    expect(payload.client_id).toBe('1234567890.1234567890')
  })

  /**
   * A single-page app queues events across route changes, so each line carries
   * the page its own event happened on while the shared context carries the page
   * the hit was flushed from. Taking the shared one would report every event
   * against whichever page the visitor happened to be on at the end.
   */
  it('gives each event its own page, not the page the hit was sent from', () => {
    const { payload } = forward(ALL_BEACONS.batchedAcrossPages)
    expect(payload.events.map((e: any) => e.params.dl)).toEqual([
      'https://shop.example.com/products/kettle',
      'https://shop.example.com/products/mug',
      // This one named no page of its own, so it falls back to the shared hit.
      'https://shop.example.com/checkout',
    ])
  })

  it('still treats an unbatched form-encoded hit as one event', () => {
    const { payload } = forward(ALL_BEACONS.formEncoded)
    expect(payload.events).toHaveLength(1)
    expect(payload.events[0].name).toBe('add_to_cart')
    expect(payload.events[0].params.item_name).toBe('Kettle')
    expect(payload.events[0].params.value).toBe(24.5)
  })
})

describe('identifiers are pseudonymised, not passed through', () => {
  it('hashes the site user id', () => {
    const { payload } = forward(ALL_BEACONS.identifiedUser)
    expect(payload.user_id).toMatch(/^[0-9a-f]{64}$/)
    expect(payload.user_id).not.toBe('user-90210')
  })

  it('hashes a numeric site user id, which used to walk past the rule', () => {
    const { payload } = forward(ALL_BEACONS.numericUserId)
    expect(payload.user_id).toMatch(/^[0-9a-f]{64}$/)
  })

  it('leaves the transaction id alone, which is the vendor’s own and not a person', () => {
    const { payload } = forward(ALL_BEACONS.identifiedUser)
    expect(payload.events[0].params.transaction_id).toBe('T-88213')
  })
})

/**
 * Rule health, answered statically. `/api/rule-health` reports a declared path
 * that never fires, but only once real traffic has flowed; this asks the same
 * question of the fixtures, so a path that cannot match the shape the adapter
 * builds fails the gate instead of sitting in a dashboard nobody is reading.
 */
describe('every declared path in the rule can actually fire', () => {
  /**
   * Paths kept deliberately even though no beacon in the corpus produces them.
   *
   * This is an escape hatch, so it names a reason per entry and is asserted
   * against the rule below: an entry that stops existing, or one that starts
   * firing, has to be dealt with rather than left here. Padding the fixtures
   * with a beacon nobody sends would make the suite pass while proving nothing,
   * which is the same defect as an audit built from a rule's declarations.
   */
  const DEFENSIVE: Record<string, string> = {
    'events.*.params.uip':
      "Measurement Protocol's own name for an IP override. Reaching this path " +
      'needs a site to name an event parameter `uip`, which gtag does not do on ' +
      'its own. Kept because the field name is unambiguous about what it holds, ' +
      'and stripping by name does not depend on the value looking like an address.',
  }

  const fired = new Set<string>()
  for (const beacon of Object.values(ALL_BEACONS)) {
    for (const entry of forward(beacon).report) fired.add(entry.path)
  }

  it.each(ga4Rule.transformations.map((t) => t.path))('fires against some beacon: %s', (path) => {
    if (path in DEFENSIVE) return
    expect(fired, `declared path "${path}" matched nothing in any fixture`).toContain(path)
  })

  it('lists no exemption the rule has stopped declaring', () => {
    const declared = ga4Rule.transformations.map((t) => t.path)
    for (const path of Object.keys(DEFENSIVE)) {
      expect(declared, `"${path}" is exempted but no longer declared`).toContain(path)
    }
  })

  it('lists no exemption that does in fact fire', () => {
    for (const path of Object.keys(DEFENSIVE)) {
      expect(fired, `"${path}" fires; take it out of DEFENSIVE`).not.toContain(path)
    }
  })

  /**
   * The raw address never reaches Google whether or not the two IP paths above
   * fire, because the adapter copies nothing it has not named. The rule entries
   * are precision on top of that, not the thing doing the work.
   */
  it('removes an address sent as an event parameter, by rule and by shape alike', () => {
    const { payload, report } = forward(ALL_BEACONS.contactDetails)
    const paths = report.map((e) => e.path)

    // `ep.ip` lands where the rule declared it, so the declared pass removes it.
    expect(payload.events[0].params).not.toHaveProperty('ip')
    expect(paths).toContain('events.*.params.ip')

    // `ep.client_ip` is a name nobody declared. The value scan removes it by
    // shape, and says which detector found it — the layer that covers the
    // fields nobody knew were being sent. A scan entry carries the concrete
    // path it fired at rather than a wildcard, because it found a real value
    // rather than matching a declaration.
    expect(payload.events[0].params).not.toHaveProperty('client_ip')
    expect(report.find((e) => e.path === 'events.0.params.client_ip')).toMatchObject({
      action: 'strip',
      detector: 'ipv4',
    })
  })
})

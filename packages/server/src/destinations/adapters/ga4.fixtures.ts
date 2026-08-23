/**
 * gtag.js beacons as they go on the wire, for verifying the GA4 destination.
 *
 * **What these are.** The `/g/collect` wire format, written out parameter by
 * parameter from the shapes gtag.js sends. They are not captures from a live
 * browser session — this repository has no way to take one — so they verify the
 * rule and the adapter against the documented format rather than against a
 * recording. That is a weaker claim than "checked against a real beacon" and is
 * stated here so nobody reads it as the stronger one. Replacing these with real
 * captures is a strict improvement and needs no other change.
 *
 * **What the parameters mean.** gtag splits an event across prefixes: `ep.` is a
 * string event parameter and `epn.` a numeric one, `up.`/`upn.` are user
 * properties, and the unprefixed keys are page and session context. Everything
 * a site passes to `gtag('event', name, {...})` arrives as `ep.`/`epn.`, which
 * is why an application's own fields — an email included — turn up there.
 */

const HOST = 'https://www.google-analytics.com/g/collect'

/** The context params gtag puts on every hit, unrelated to the event itself. */
const COMMON = {
  v: '2', // protocol version
  tid: 'G-TEST12345', // measurement id
  gtm: '45je45a0v9199063843z8', // container version
  _p: '1743287492', // page-load hash
  cid: '1234567890.1234567890', // client id
  ul: 'en-gb', // user language
  sr: '1920x1080', // screen resolution
  _s: '1', // hit sequence within the page
  sid: '1755950400', // session id
  sct: '3', // session count
  seg: '1', // session engaged
  _et: '4821', // engagement time, ms
  uaa: 'x86', // user-agent client hints, one param each
  uab: '64',
  uamb: '0',
  uap: 'Linux',
}

export interface Beacon {
  /** What the browser was heading to, which is what `X-Original-Url` carries. */
  url: string
  /** Present only for the form-encoded and batched transports. */
  body?: string
  contentType?: string
}

function beacon(event: Record<string, string>, common: Record<string, string> = COMMON): Beacon {
  return { url: `${HOST}?${new URLSearchParams({ ...common, ...event })}` }
}

/** An ordinary page view: no application data, nothing to remove. */
export const pageView = beacon({
  en: 'page_view',
  dl: 'https://shop.example.com/products/kettle',
  dt: 'Kettle — Example Shop',
  dr: 'https://www.google.com/',
})

/** A site passing its own fields to gtag, one of which is an email address. */
export const signupWithEmail = beacon({
  en: 'sign_up',
  dl: 'https://shop.example.com/signup',
  dt: 'Sign up',
  'ep.method': 'email',
  'ep.email': 'alice@example.com',
  'ep.user_email': 'alice@example.com',
})

/**
 * The expensive shape: personal data in the page URL rather than in a field
 * anybody declared. A confirmation page routinely carries the address it just
 * confirmed, and `dl` is sent on every single hit.
 */
export const confirmationUrlCarryingEmail = beacon({
  en: 'page_view',
  dl: 'https://shop.example.com/welcome?email=alice@example.com&ref=newsletter',
  dt: 'Welcome, alice@example.com',
  dr: 'https://shop.example.com/signup',
})

/** A logged-in visitor: gtag sends the site's own user id as `uid`. */
export const identifiedUser = beacon({
  en: 'purchase',
  dl: 'https://shop.example.com/checkout/complete',
  uid: 'user-90210',
  'epn.value': '49.99',
  'ep.currency': 'GBP',
  'ep.transaction_id': 'T-88213',
})

/** The same, where the site's user id is a number rather than a string. */
export const numericUserId = beacon({
  en: 'purchase',
  dl: 'https://shop.example.com/checkout/complete',
  uid: '4815162342',
  'epn.value': '19.99',
})

/**
 * User properties. A site setting `user_properties` on its gtag config sends
 * them as `up.`/`upn.` on every hit, and they are a well-worn route for an
 * address or a phone number to reach an analytics vendor.
 */
export const userPropertiesCarryingPii = beacon({
  en: 'page_view',
  dl: 'https://shop.example.com/account',
  'up.email': 'alice@example.com',
  'up.phone': '+447700900123',
  'up.plan': 'premium',
  'upn.lifetime_value': '480',
})

/** Contact details and an address a site sent as ordinary event parameters. */
export const contactDetails = beacon({
  en: 'lead_submitted',
  dl: 'https://shop.example.com/contact',
  'ep.phone': '+14155550100',
  // `ep.ip` is what a site passing an address to `gtag('event', ...)` produces,
  // and it is the shape the rule's `events.*.params.ip` entry exists for.
  'ep.ip': '203.0.113.9',
  'ep.client_ip': '198.51.100.4',
  'ep.ipv6': '2001:db8::8a2e:370:7334',
  'ep.card': '4111111111111111',
})

/** Some gtag versions POST the whole hit form-encoded with an empty query. */
export const formEncoded: Beacon = {
  url: HOST,
  body: new URLSearchParams({
    ...COMMON,
    en: 'add_to_cart',
    dl: 'https://shop.example.com/products/kettle',
    'ep.item_name': 'Kettle',
    'epn.value': '24.5',
  }).toString(),
  contentType: 'application/x-www-form-urlencoded',
}

/**
 * A batch. gtag keeps the shared context in the query string and puts one line
 * per event in the body, separated by CRLF, once more than one event is queued.
 */
export const batched: Beacon = {
  url: `${HOST}?${new URLSearchParams(COMMON)}`,
  body: [
    'en=page_view&dl=https%3A%2F%2Fshop.example.com%2F',
    'en=sign_up&ep.email=alice%40example.com',
    'en=purchase&epn.value=12.5',
  ].join('\r\n'),
  contentType: 'application/x-www-form-urlencoded',
}

/**
 * A batch whose events happened on different pages, which is what a single-page
 * app produces when it queues events across route changes before flushing. The
 * shared context carries the page the hit was sent from; each line carries the
 * page its own event happened on, and that is the one that belongs to it.
 */
export const batchedAcrossPages: Beacon = {
  url: `${HOST}?${new URLSearchParams({ ...COMMON, dl: 'https://shop.example.com/checkout' })}`,
  body: [
    'en=view_item&dl=https%3A%2F%2Fshop.example.com%2Fproducts%2Fkettle&ep.item=Kettle',
    'en=add_to_cart&dl=https%3A%2F%2Fshop.example.com%2Fproducts%2Fmug&ep.item=Mug',
    'en=begin_checkout&epn.value=31.5',
  ].join('\r\n'),
  contentType: 'application/x-www-form-urlencoded',
}

/** Everything above, for the sweeps that assert a property across all of them. */
export const ALL_BEACONS: Record<string, Beacon> = {
  pageView,
  signupWithEmail,
  confirmationUrlCarryingEmail,
  identifiedUser,
  numericUserId,
  userPropertiesCarryingPii,
  contactDetails,
  formEncoded,
  batched,
  batchedAcrossPages,
}

import { scrubPayload } from '../../engine/transformer'
import type { VendorAdapter, VendorContext, AdapterResult } from './types'

/**
 * Google Analytics 4 adapter.
 *
 * Accepts intercepted gtag beacons (which target /g/collect and encode the
 * event as query-string params or a form-encoded body) and translates them
 * into the Measurement Protocol JSON schema, then forwards to
 * https://www.google-analytics.com/mp/collect using a server-side
 * measurement_id + api_secret.
 *
 * Requires GA4_MEASUREMENT_ID and GA4_API_SECRET in the environment. Without
 * them the adapter reports { skip: true } and the request is dropped with a
 * 204 — the browser SDK still sees a clean success.
 */
export const ga4Adapter: VendorAdapter = {
  buildRequest(ctx: VendorContext): AdapterResult {
    const { measurementId, apiSecret } = ctx.serverConfig.ga4
    if (!measurementId || !apiSecret) {
      return { skip: true, reason: 'GA4_MEASUREMENT_ID or GA4_API_SECRET not configured' }
    }

    // gtag beacons put the hit's shared context in the query string: client id,
    // session, language, and the page. Fall back to the request's own query when
    // the original URL header is missing.
    let shared: URLSearchParams
    try {
      shared = new URL(ctx.originalUrl).searchParams
    } catch {
      shared = new URLSearchParams(ctx.query)
    }

    // Some SDK versions POST the hit form-encoded instead, and once more than
    // one event is queued gtag batches them: shared context stays in the query
    // string and the body carries one event per CRLF-separated line.
    //
    // The lines used to be handed to `URLSearchParams` whole. Splitting on `&`
    // then ran straight through the line breaks, so a three-event batch became
    // one event wearing the others' parameters — a page_view carrying a
    // purchase's value and a `dl` with a literal newline in it. That is not lost
    // data, it is invented data, which is worse in a tool whose product is that
    // its reporting is derived from what actually happened.
    const contentType = ctx.headers['content-type'] || ''
    const lines =
      ctx.rawBody && contentType.includes('application/x-www-form-urlencoded')
        ? ctx.rawBody
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        : []

    // A single hit is one event whose parameters may be split across the query
    // and the body, so the two are merged with the query winning. A batch keeps
    // each line separate, because that separation is what identifies the events.
    let eventSources: URLSearchParams[]
    if (lines.length > 1) {
      eventSources = lines.map((line) => new URLSearchParams(line))
    } else {
      if (lines.length === 1) {
        new URLSearchParams(lines[0]).forEach((value, key) => {
          if (!shared.has(key)) shared.set(key, value)
        })
      }
      eventSources = [shared]
    }

    const clientId = shared.get('cid') || shared.get('_p') || 'unknown'

    // Measurement Protocol accepts at most 25 events per request and rejects the
    // whole call over that, so a cap keeps most of a batch rather than none of
    // it. gtag does not queue anything approaching this.
    const MAX_EVENTS = 25

    let mpPayload: any = {
      client_id: clientId,
      events: eventSources.slice(0, MAX_EVENTS).map((source) => buildEvent(source, shared)),
    }

    const userId = shared.get('uid')
    if (userId) mpPayload.user_id = userId

    // Apply declarative rule transformations against the MP-shaped payload, then
    // the value scan, and carry the report out so the audit reflects this scrub
    // rather than the rule.
    const scrub = scrubPayload(mpPayload, ctx.rule, {
      detectors: ctx.serverConfig.detectors,
      hasher: ctx.hasher,
    })
    mpPayload = scrub.payload

    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(
      measurementId,
    )}&api_secret=${encodeURIComponent(apiSecret)}`

    return {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mpPayload),
      report: scrub.report,
    }
  },
}

/**
 * One Measurement Protocol event from one set of gtag parameters.
 *
 * gtag prefixes a string event parameter `ep.` and a numeric one `epn.`, so
 * everything a site passes to `gtag('event', name, {...})` arrives under one of
 * those — which is why an application's own fields, an address included, turn up
 * here rather than anywhere a vendor named.
 *
 * The five unprefixed keys below are the only context that survives. That makes
 * this an allowlist rather than a blocklist: a parameter nobody has considered
 * is dropped instead of forwarded, so `up.` user properties, session counters
 * and client hints never reach the vendor at all. It is the reason most of what
 * `ga4.verify.test.ts` asserts holds for fields no rule mentions.
 */
function buildEvent(source: URLSearchParams, shared: URLSearchParams) {
  const params: Record<string, any> = {}

  source.forEach((value, key) => {
    if (key.startsWith('ep.')) {
      params[key.slice(3)] = value
    } else if (key.startsWith('epn.')) {
      const n = Number(value)
      if (!Number.isNaN(n)) params[key.slice(4)] = n
    }
  })

  // Page and locale context, taken from the event's own line first so a batch
  // whose events span pages keeps each one's URL, then from the shared hit.
  for (const key of ['dl', 'dt', 'dr', 'ul', 'sr']) {
    if (key in params) continue
    const value = source.get(key) ?? shared.get(key)
    if (value !== null && value !== undefined) params[key] = value
  }

  return { name: source.get('en') || shared.get('en') || 'page_view', params }
}

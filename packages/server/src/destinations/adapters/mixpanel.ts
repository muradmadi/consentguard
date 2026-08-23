import { scrubPayload } from '../../engine/transformer'
import type { VendorAdapter, VendorContext, AdapterResult } from './types'

/**
 * Mixpanel adapter.
 *
 * Mixpanel's browser SDK base64-encodes the event batch into a single `data`
 * parameter. Neither scrub pass can see through that: the body scrub sees one
 * opaque string and the URL scrub sees one opaque query parameter, so before
 * this adapter existed a Mixpanel beacon was forwarded verbatim and audited as
 * `forwarded` with no transformations. The record was accurate and the payload
 * still carried whatever the page had put in it.
 *
 * Decoding is therefore the whole job. Once the batch is JSON the rule's paths
 * apply to it normally and it goes to the server-side ingestion endpoint. The
 * project token travels inside `properties.token` where the SDK put it, so this
 * needs no configuration — which is why an unconfigured deployment gets real
 * protection here rather than a skip.
 */
export const mixpanelAdapter: VendorAdapter = {
  buildRequest(ctx: VendorContext): AdapterResult {
    const encoded = readDataParam(ctx)
    if (!encoded) return { skip: true, reason: 'no data parameter in mixpanel beacon' }

    const decoded = decodeBatch(encoded)
    // Refusing beats guessing: an envelope we cannot read is one we cannot
    // scrub, and this destination's whole reason for having an adapter is that
    // forwarding an unreadable payload is what it used to do.
    if (decoded === null) return { skip: true, reason: 'mixpanel data parameter did not decode' }

    // A single event and a batch are the same thing to the ingestion endpoint,
    // and normalising here is what lets the rule address one shape.
    const events = Array.isArray(decoded) ? decoded : [decoded]

    const scrub = scrubPayload(events, ctx.rule, {
      detectors: ctx.serverConfig.detectors,
      hasher: ctx.hasher,
    })

    return {
      url: 'https://api.mixpanel.com/track?verbose=1',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(scrub.payload),
      report: scrub.report,
    }
  },
}

/**
 * The SDK sends `data` as a form field, as a query parameter on a GET, or — on
 * a version configured for it — as a raw JSON body with no wrapper at all.
 */
function readDataParam(ctx: VendorContext): string {
  const contentType = ctx.headers['content-type'] || ''

  if (ctx.rawBody && contentType.includes('application/x-www-form-urlencoded')) {
    const fromBody = new URLSearchParams(ctx.rawBody).get('data')
    if (fromBody) return fromBody
  }

  if (ctx.rawBody && contentType.includes('application/json')) return ctx.rawBody

  try {
    const fromUrl = new URL(ctx.originalUrl).searchParams.get('data')
    if (fromUrl) return fromUrl
  } catch {
    // No original URL to read; fall through to the proxy's own query.
  }

  return ctx.query.get('data') || ctx.rawBody || ''
}

/**
 * Base64 first, then plain JSON. `api_payload_format: 'json'` makes the SDK
 * skip the encoding, so both arrive in the wild.
 */
function decodeBatch(encoded: string): any {
  const asJson = parseJson(encoded)
  if (asJson !== null) return asJson

  try {
    // Form decoding turns a base64 `+` into a space unless the SDK escaped it.
    const normalized = encoded.replace(/ /g, '+')
    return parseJson(Buffer.from(normalized, 'base64').toString('utf8'))
  } catch {
    return null
  }
}

/** Null for anything that is not a JSON object or array — a bare string is not a batch. */
function parseJson(raw: string): any {
  try {
    const value = JSON.parse(raw)
    return value !== null && typeof value === 'object' ? value : null
  } catch {
    return null
  }
}

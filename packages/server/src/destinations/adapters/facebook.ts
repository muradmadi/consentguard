import { scrubPayload } from '../../engine/transformer'
import type { VendorAdapter, VendorContext, AdapterResult } from './types'

/** Pinned rather than "latest": Meta breaks field shapes between versions. */
const GRAPH_VERSION = 'v21.0'

/**
 * Meta Conversions API adapter.
 *
 * The browser pixel is a bodyless GET to `facebook.com/tr` whose whole payload
 * is the query string: `ev` names the event, `ud[...]` carries user data,
 * `cd[...]` carries custom data. CAPI wants a completely different shape — a
 * JSON envelope posted to a pixel-scoped Graph endpoint — so this translates
 * one into the other and forwards server-side.
 *
 * Until this existed, `facebook_pixel` fell through to the generic passthrough:
 * the pixel URL was scrubbed and forwarded to Meta as-is, which worked, but the
 * rule's `em` and `ph` match keys address the CAPI body and so had never fired
 * once. An address in `ud[em]` was caught by the value scan instead and
 * correctly pseudonymised — a keyed digest Meta cannot match, so the event
 * arrived and attributed to nobody. That is the failure the two hash modes were
 * introduced to prevent, and it needed this adapter to actually fix.
 *
 * Requires META_PIXEL_ID and META_ACCESS_TOKEN. Without them the adapter
 * reports { skip: true } and the request is dropped with a 204 — the pixel sees
 * a clean success either way.
 */
export const facebookAdapter: VendorAdapter = {
  buildRequest(ctx: VendorContext): AdapterResult {
    const { pixelId, accessToken, testEventCode } = ctx.serverConfig.meta
    if (!pixelId || !accessToken) {
      return { skip: true, reason: 'META_PIXEL_ID or META_ACCESS_TOKEN not configured' }
    }

    let params: URLSearchParams
    try {
      params = new URL(ctx.originalUrl).searchParams
    } catch {
      params = new URLSearchParams(ctx.query)
    }

    // A pixel with no event name is a loader hit, not a conversion.
    const eventName = params.get('ev')
    if (!eventName) return { skip: true, reason: 'no event name in pixel beacon' }

    const userData: Record<string, any> = bracketed(params, 'ud')
    const customData: Record<string, any> = bracketed(params, 'cd')

    // Populated so the rule visibly removes them. Both reach the proxy — the
    // user agent as a header, the address as the connecting peer — and both are
    // stripped by a declared transformation, which is what puts "no raw IP
    // reached Meta" in the audit as evidence rather than as an omission.
    const clientIp = firstForwardedFor(ctx.headers['x-forwarded-for'])
    if (clientIp) userData.client_ip_address = clientIp
    if (ctx.headers['user-agent']) userData.client_user_agent = ctx.headers['user-agent']

    let payload: any = {
      data: [
        {
          event_name: eventName,
          event_time: eventTimeSeconds(params.get('ts')),
          // Meta deduplicates a CAPI event against the browser pixel event of
          // the same id. The pixel minted this one; carrying it through is what
          // stops a site that runs both from double-counting.
          ...(params.get('eid') ? { event_id: params.get('eid') } : {}),
          action_source: 'website',
          ...(params.get('dl') ? { event_source_url: params.get('dl') } : {}),
          user_data: userData,
          custom_data: customData,
        },
      ],
      ...(testEventCode ? { test_event_code: testEventCode } : {}),
    }

    const scrub = scrubPayload(payload, ctx.rule, {
      detectors: ctx.serverConfig.detectors,
      hasher: ctx.hasher,
    })
    payload = scrub.payload

    // The token goes in the body, not the query string: the URL is what gets
    // logged, audited and scrubbed, and a long-lived Meta token has no business
    // in any of those.
    payload.access_token = accessToken

    return {
      url: `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(pixelId)}/events`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      report: scrub.report,
    }
  },
}

/**
 * Collect the `ud[em]`-style parameters the pixel uses for its nested objects.
 * A bracket with nothing in it addresses no field and is dropped.
 */
function bracketed(params: URLSearchParams, prefix: string): Record<string, any> {
  const out: Record<string, any> = {}
  params.forEach((value, key) => {
    if (!key.startsWith(`${prefix}[`) || !key.endsWith(']')) return
    const field = key.slice(prefix.length + 1, -1)
    if (field) out[field] = value
  })
  return out
}

/**
 * CAPI takes seconds; the pixel sends milliseconds. Meta rejects an event more
 * than seven days old, so an unparseable or absent timestamp becomes now rather
 * than the epoch.
 */
function eventTimeSeconds(raw: string | null): number {
  const ms = Number(raw)
  if (!raw || !Number.isFinite(ms) || ms <= 0) return Math.floor(Date.now() / 1000)
  return Math.floor(ms / 1000)
}

/** The client's own address is the first hop; the rest are proxies. */
function firstForwardedFor(header: string | undefined): string {
  return header ? header.split(',')[0].trim() : ''
}

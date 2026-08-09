import { scrubPayload } from '../../engine/transformer';
import type { VendorAdapter, VendorContext, AdapterResult } from './types';

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
    const { measurementId, apiSecret } = ctx.serverConfig.ga4;
    if (!measurementId || !apiSecret) {
      return { skip: true, reason: 'GA4_MEASUREMENT_ID or GA4_API_SECRET not configured' };
    }

    // gtag beacons put event data in the original URL's query string.
    // Fall back to the request's own query if the original URL header is missing.
    let params: URLSearchParams;
    try {
      params = new URL(ctx.originalUrl).searchParams;
    } catch {
      params = new URLSearchParams(ctx.query);
    }

    // Some SDK versions POST the payload as application/x-www-form-urlencoded
    // in the body. Merge those in, but let query-string values win.
    const contentType = ctx.headers['content-type'] || '';
    if (ctx.rawBody && contentType.includes('application/x-www-form-urlencoded')) {
      new URLSearchParams(ctx.rawBody).forEach((value, key) => {
        if (!params.has(key)) params.set(key, value);
      });
    }

    const clientId = params.get('cid') || params.get('_p') || 'unknown';
    const eventName = params.get('en') || 'page_view';

    const eventParams: Record<string, any> = {};
    params.forEach((value, key) => {
      if (key.startsWith('ep.')) {
        eventParams[key.slice(3)] = value;
      } else if (key.startsWith('epn.')) {
        const n = Number(value);
        if (!Number.isNaN(n)) eventParams[key.slice(4)] = n;
      }
    });

    // Preserve a handful of standard GA4 params that aren't event-scoped.
    const passthroughKeys = ['dl', 'dt', 'dr', 'ul', 'sr'];
    for (const k of passthroughKeys) {
      const v = params.get(k);
      if (v !== null && !(k in eventParams)) eventParams[k] = v;
    }

    let mpPayload: any = {
      client_id: clientId,
      events: [{ name: eventName, params: eventParams }],
    };

    const userId = params.get('uid');
    if (userId) mpPayload.user_id = userId;

    // Apply declarative rule transformations against the MP-shaped payload,
    // then mark scrubbed so the caller skips the second pass.
    mpPayload = scrubPayload(mpPayload, ctx.rule);

    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(
      measurementId,
    )}&api_secret=${encodeURIComponent(apiSecret)}`;

    return {
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mpPayload),
      scrubbed: true,
    };
  },
};

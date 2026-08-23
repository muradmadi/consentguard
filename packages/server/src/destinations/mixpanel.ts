import { DestinationRule } from '@sluice/shared'

/**
 * Mixpanel's browser SDK base64-encodes the event batch into a `data`
 * parameter, so neither the body scrub nor the URL scrub can see inside it:
 * without ./adapters/mixpanel.ts this destination forwarded personal data and
 * audited a clean `forwarded` with no transformations. `transport: 'opaque'`
 * is what says so, and what refuses the request if the adapter ever goes away.
 *
 * The decoded payload is an array of events, which is why every path leads with
 * a wildcard. `properties.$email` — the path this rule carried before the
 * adapter existed — could not match anything the vendor is actually sent.
 */
export const mixpanel: DestinationRule = {
  id: 'mixpanel',
  category: 'analytics',
  // api-js.mixpanel.com is the host the JS SDK posts to; api.mixpanel.com is
  // the server-side endpoint the adapter forwards to.
  endpoints: ['api.mixpanel.com', 'api-js.mixpanel.com'],
  transport: 'opaque',
  upstreamUrl: 'https://api.mixpanel.com/track',
  transformations: [
    { path: '*.properties.$email', action: 'hash' },
    { path: '*.properties.distinct_id', action: 'hash' },
    { path: '*.properties.ip', action: 'strip' },
    { path: '*.properties.$ip', action: 'strip' },
  ],
}

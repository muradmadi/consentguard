import { DestinationRule } from '@sluice/shared'

/**
 * `em` and `ph` are the two fields Meta's Conversions API matches on, and the
 * only two places in this repository where an unsalted digest is allowed out.
 * Meta specifies the normalisation and the plain SHA-256 itself, so a
 * pseudonymised value here would be well-formed, accepted, and match nobody —
 * the failure the modes exist to make impossible to write by accident. Everything
 * else about this destination stays pseudonymised or removed.
 *
 * The paths address the CAPI body that ./adapters/facebook.ts builds, not the
 * `ud[em]` query parameters the browser pixel sends. They were written that way
 * before the adapter existed, which is why they had never once fired.
 *
 * No `upstreamUrl`: a CAPI call is addressed to a specific pixel id, so the
 * adapter builds the URL from configuration. This field used to hold a literal
 * `<PIXEL_ID>` template, which is a URL that cannot be called.
 */
export const facebook: DestinationRule = {
  id: 'facebook_pixel',
  category: 'marketing',
  endpoints: ['facebook.net', 'facebook.com/tr'],
  transport: 'pixel',
  transformations: [
    { path: 'data.*.user_data.em', action: 'hash', mode: 'match_key', normalize: 'email' },
    { path: 'data.*.user_data.ph', action: 'hash', mode: 'match_key', normalize: 'phone' },
    { path: 'data.*.user_data.client_ip_address', action: 'strip' },
    { path: 'data.*.user_data.client_user_agent', action: 'strip' },
    { path: 'data.*.custom_data.order_id', action: 'redact', pattern: 'ORDER-[0-9]+' },
  ],
}

import { DestinationRule } from '@sluice/shared'

/**
 * Hotjar is session recording, not an analytics beacon. What it sends is a
 * compressed envelope of DOM mutations and input events, and there is no path
 * into it for either scrub pass: a form field's contents are inside the
 * recording, not at `payload.data.form_fields.*.value`. The rule below could
 * never have matched what the vendor actually receives.
 *
 * `transport: 'opaque'` makes that a refusal rather than a silent passthrough.
 * The entry stays in the registry so the client keeps intercepting Hotjar and
 * the firewall keeps blocking it; deleting it would drop the interception and
 * send the recording straight to the vendor.
 *
 * Serving Hotjar honestly means an adapter that can read the envelope. Nobody
 * has written one, and the rule no longer pretends otherwise.
 */
export const hotjar: DestinationRule = {
  id: 'hotjar',
  category: 'analytics',
  // hotjar.io carries the recording payloads and was never declared here, so
  // those requests were not intercepted at all. Declared now, and refused.
  endpoints: ['vars.hotjar.com', 'static.hotjar.com', 'script.hotjar.com', 'hotjar.io'],
  transport: 'opaque',
  transformations: [],
}

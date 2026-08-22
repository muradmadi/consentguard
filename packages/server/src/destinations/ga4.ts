import { DestinationRule } from '@sluice/shared';

/**
 * GA4 uses a real vendor adapter (see ./adapters/ga4.ts) that translates
 * intercepted gtag beacons into the Measurement Protocol payload:
 *   { client_id, user_id?, events: [{ name, params: {...} }] }
 *
 * These transformation paths target that shape after the adapter has built
 * it, not the raw beacon fields.
 */
export const ga4: DestinationRule = {
  id: 'ga4',
  category: 'analytics',
  endpoints: ['google-analytics.com', 'analytics.google.com'],
  transformations: [
    { path: 'user_id', action: 'hash' },
    { path: 'events.*.params.email', action: 'hash' },
    { path: 'events.*.params.user_email', action: 'hash' },
    { path: 'events.*.params.ip', action: 'strip' },
    { path: 'events.*.params.uip', action: 'strip' },
  ],
};

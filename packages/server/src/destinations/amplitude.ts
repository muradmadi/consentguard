import { DestinationRule } from '@sluice/shared'

/**
 * Amplitude's browser SDK posts the HTTP V2 envelope — `{ api_key, events: [] }`
 * — as JSON to the endpoint below, and these paths address that shape directly.
 * No adapter is needed: the scrubbed body goes to the URL the browser targeted.
 *
 * `api_key` used to be stripped here "to avoid leaking it". It is Amplitude's
 * own authentication for the call we are making, it is a public client key that
 * ships in the page anyway, and removing it made the vendor reject every single
 * forward — a transformation that protected nothing and broke everything.
 */
export const amplitude: DestinationRule = {
  id: 'amplitude',
  category: 'analytics',
  endpoints: ['amplitude.com'],
  transport: 'json',
  upstreamUrl: 'https://api2.amplitude.com/2/httpapi',
  transformations: [
    { path: 'events.*.user_id', action: 'hash' },
    { path: 'events.*.device_id', action: 'hash' },
    { path: 'events.*.user_properties.email', action: 'strip' },
    { path: 'events.*.ip', action: 'strip' },
  ],
}

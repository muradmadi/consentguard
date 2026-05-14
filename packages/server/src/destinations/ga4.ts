import { DestinationRule } from '@consentguard/shared';

export const ga4: DestinationRule = {
  id: 'ga4',
  category: 'analytics',
  endpoints: ['google-analytics.com'],
  upstreamUrl: 'https://www.google-analytics.com/g/collect',
  transformations: [
    { path: 'en', action: 'strip' }, // Example: strip event name if we wanted to
    { path: 'uid', action: 'hash' },
    { path: 'uip', action: 'strip' },
  ],
};

import { DestinationRule } from '@sluice/shared';

export const mixpanel: DestinationRule = {
  id: 'mixpanel',
  category: 'analytics',
  endpoints: ['api.mixpanel.com'],
  upstreamUrl: 'https://api.mixpanel.com/track',
  transformations: [
    { path: 'properties.$email', action: 'hash' },
    { path: 'properties.distinct_id', action: 'hash' },
    { path: 'properties.ip', action: 'strip' },
  ],
};

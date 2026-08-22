import { DestinationRule } from '@sluice/shared';

export const amplitude: DestinationRule = {
  id: 'amplitude',
  category: 'analytics',
  endpoints: ['amplitude.com'],
  upstreamUrl: 'https://api2.amplitude.com/2/httpapi',
  transformations: [
    { path: 'api_key', action: 'strip' }, // Don't leak API key if possible
    { path: 'events.*.user_id', action: 'hash' },
    { path: 'events.*.device_id', action: 'hash' },
    { path: 'events.*.user_properties.email', action: 'strip' },
    { path: 'events.*.ip', action: 'strip' },
  ],
};

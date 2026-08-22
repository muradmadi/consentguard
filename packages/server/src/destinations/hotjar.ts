import { DestinationRule } from '@sluice/shared';

export const hotjar: DestinationRule = {
  id: 'hotjar',
  category: 'analytics',
  endpoints: ['vars.hotjar.com', 'static.hotjar.com', 'script.hotjar.com'],
  upstreamUrl: 'https://vars.hotjar.com/api/v2/log',
  transformations: [
    {
      path: 'payload.data.form_fields.*.value',
      action: 'redact',
    },
    {
      path: 'payload.data.user_id',
      action: 'hash',
    },
    {
      path: 'payload.data.ip',
      action: 'strip',
    }
  ],
};

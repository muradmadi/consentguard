import { DestinationRule } from '@consentguard/shared';

export const facebook: DestinationRule = {
  id: 'facebook_pixel',
  category: 'marketing',
  endpoints: ['facebook.net', 'facebook.com/tr'],
  upstreamUrl: 'https://graph.facebook.com/v17.0/<PIXEL_ID>/events', // Template, will need PIXEL_ID from payload or config
  transformations: [
    { path: 'data.*.user_data.em', action: 'hash' }, // Email
    { path: 'data.*.user_data.ph', action: 'hash' }, // Phone
    { path: 'data.*.user_data.client_ip_address', action: 'strip' },
    { path: 'data.*.user_data.client_user_agent', action: 'strip' },
    { path: 'data.*.custom_data.order_id', action: 'redact', pattern: 'ORDER-[0-9]+' },
  ],
};

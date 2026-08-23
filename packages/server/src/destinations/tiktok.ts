import { DestinationRule } from '@sluice/shared'

export const tiktok: DestinationRule = {
  id: 'tiktok',
  category: 'marketing',
  endpoints: ['analytics.tiktok.com', 'business-api.tiktok.com'],
  // The pixel posts a JSON envelope to the endpoint it was going to anyway,
  // so the scrubbed body reaches the vendor without a translation step.
  transport: 'json',
  upstreamUrl: 'https://analytics.tiktok.com/api/v2/track',
  transformations: [
    {
      path: 'context.user.email',
      action: 'hash',
    },
    {
      path: 'context.user.phone_number',
      action: 'hash',
    },
    {
      path: 'context.ip',
      action: 'hash',
    },
    {
      path: 'properties.content_id',
      action: 'redact',
      pattern: 'ID-[0-9]+', // Example of redact with pattern
    },
  ],
}

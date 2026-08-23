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
      // Stripped, not hashed. `detectors/patterns.ts` states the policy for an
      // address and this rule used to contradict it: a hash of an IP is still a
      // stable identifier for a household, and no vendor has a legitimate need
      // for the raw one. Two destinations disagreeing about what an address is
      // worth is the inconsistency, not either answer on its own.
      path: 'context.ip',
      action: 'strip',
    },
  ],
}

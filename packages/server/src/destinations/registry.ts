import { DestinationRule } from '@consentguard/shared';

const REGISTRY: Record<string, DestinationRule> = {
  ga4: {
    id: 'ga4',
    category: 'analytics',
    endpoints: ['*.google-analytics.com'],
    upstreamUrl: 'https://www.google-analytics.com/g/collect',
    transformations: [
      { path: 'events.*.params.email', action: 'strip' },
      { path: 'events.*.params.user_id', action: 'hash' },
      { path: 'client_id', action: 'hash' },
    ],
  },
  mixpanel: {
    id: 'mixpanel',
    category: 'analytics',
    endpoints: ['api.mixpanel.com/track'],
    upstreamUrl: 'https://api.mixpanel.com/track',
    transformations: [
      { path: 'properties.$email', action: 'strip' },
      { path: 'properties.distinct_id', action: 'hash' },
    ],
  },
};

export function getDestinationRule(id: string): DestinationRule | null {
  return REGISTRY[id] || null;
}

/**
 * Safe default rule for unknown destinations.
 */
export function getDefaultRule(id: string): DestinationRule {
  return {
    id,
    category: 'necessary', // Unknown destinations assumed necessary but heavily scrubbed
    endpoints: [],
    transformations: [
      { path: 'email', action: 'strip' },
      { path: 'user_id', action: 'hash' },
      { path: 'ip', action: 'strip' },
    ],
  };
}

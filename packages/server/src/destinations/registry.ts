import { DestinationRule } from '@consentguard/shared';
import { ga4 } from './ga4';
import { mixpanel } from './mixpanel';
import { amplitude } from './amplitude';
import { facebook } from './facebook';

const REGISTRY: Record<string, DestinationRule> = {
  ga4,
  mixpanel,
  amplitude,
  facebook_pixel: facebook,
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

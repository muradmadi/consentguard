import { DestinationRule, UNKNOWN_DESTINATION_CATEGORY } from '@sluice/shared'
import { ga4 } from './ga4'
import { mixpanel } from './mixpanel'
import { amplitude } from './amplitude'
import { facebook } from './facebook'

import { tiktok } from './tiktok'
import { hotjar } from './hotjar'

const REGISTRY: Record<string, DestinationRule> = {
  ga4,
  mixpanel,
  amplitude,
  facebook_pixel: facebook,
  tiktok,
  hotjar,
}

export const REGISTRY_KEYS = Object.keys(REGISTRY)

export function getDestinationRule(id: string): DestinationRule | null {
  return REGISTRY[id] || null
}

/**
 * Safe default rule for unknown destinations.
 *
 * The category used to be `necessary`, which `hasConsent` grants to everyone
 * unconditionally — a fail-open branch reachable through a malformed rule
 * override, in a system whose first invariant is fail-closed. It is now a
 * category nothing grants: a destination nobody declared is not one anybody
 * consented to.
 */
export function getDefaultRule(id: string): DestinationRule {
  return {
    id,
    category: UNKNOWN_DESTINATION_CATEGORY,
    endpoints: [],
    transformations: [
      { path: 'email', action: 'strip' },
      { path: 'user_id', action: 'hash' },
      { path: 'ip', action: 'strip' },
    ],
  }
}

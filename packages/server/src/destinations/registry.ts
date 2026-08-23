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
    // Refused by `supportFor` as unconditionally as `unknown` is refused by
    // `hasConsent`. A payload nobody declared a transport for is not one we can
    // claim to have scrubbed, so it is not one we forward.
    transport: 'opaque',
    // Deliberately empty. `supportFor` reads the `opaque` transport above and
    // refuses the request before anything is scrubbed, so a transformation here
    // could never run. Three used to be listed — email, user_id, ip — which read
    // as protection that was not there.
    transformations: [],
  }
}

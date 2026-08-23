import type { VendorAdapter } from './types'
import { ga4Adapter } from './ga4'
import { facebookAdapter } from './facebook'
import { mixpanelAdapter } from './mixpanel'

/**
 * Registry of destinations that have a real vendor adapter wired up.
 *
 * This is one half of what `destinations/support.ts` derives a support level
 * from, so adding an entry here is what promotes a destination to `adapter`.
 * Destinations not listed fall through to the generic passthrough, which is
 * genuine support for a vendor whose transport the scrub passes can read and no
 * support at all for one whose payload is encoded — hence the other half.
 */
const ADAPTERS: Record<string, VendorAdapter> = {
  ga4: ga4Adapter,
  facebook_pixel: facebookAdapter,
  mixpanel: mixpanelAdapter,
}

export function getAdapter(destinationId: string): VendorAdapter | undefined {
  return ADAPTERS[destinationId]
}

export const ADAPTER_IDS = Object.keys(ADAPTERS)

export type { VendorAdapter, VendorContext, VendorForward, AdapterResult } from './types'

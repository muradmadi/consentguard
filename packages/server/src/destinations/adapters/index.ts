import type { VendorAdapter } from './types';
import { ga4Adapter } from './ga4';

/**
 * Registry of destinations that have a real vendor adapter wired up.
 * Destinations not listed here fall through to the generic JSON passthrough,
 * which is only useful for testing — it will not produce a valid request for
 * a real vendor API.
 */
const ADAPTERS: Record<string, VendorAdapter> = {
  ga4: ga4Adapter,
};

export function getAdapter(destinationId: string): VendorAdapter | undefined {
  return ADAPTERS[destinationId];
}

export const ADAPTER_IDS = Object.keys(ADAPTERS);

export type { VendorAdapter, VendorContext, VendorForward, AdapterResult } from './types';

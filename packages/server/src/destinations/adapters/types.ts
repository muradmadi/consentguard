import type { DestinationRule } from '@consentguard/shared';
import type { ServerConfig } from '../../config';

/**
 * Context passed to a vendor adapter for one intercepted request.
 */
export interface VendorContext {
  method: string;
  /** URL the SDK originally targeted, before the client interceptor rewrote it. */
  originalUrl: string;
  /** Query string on the request that reached the proxy. */
  query: URLSearchParams;
  /** Lowercased request headers. */
  headers: Record<string, string>;
  /** Parsed JSON body if Content-Type was application/json. Null otherwise. */
  jsonBody: any | null;
  /** Raw body as text (form-encoded, JSON, or empty). */
  rawBody: string;
  rule: DestinationRule;
  serverConfig: ServerConfig;
}

/**
 * A concrete upstream request that the proxy should fire. Returning null
 * from an adapter means "drop this event" — the proxy will 204 and log it.
 */
export interface VendorForward {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** True if the adapter already applied its transformations. Skip the generic pass. */
  scrubbed?: boolean;
}

export type AdapterResult = VendorForward | null | { skip: true; reason: string };

export interface VendorAdapter {
  buildRequest(ctx: VendorContext): Promise<AdapterResult> | AdapterResult;
}

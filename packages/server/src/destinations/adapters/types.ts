import type { DestinationRule, TransformationRecord } from '@sluice/shared'
import type { ServerConfig } from '../../config'
import type { Hasher } from '../../engine/transformations/hash'

/**
 * Context passed to a vendor adapter for one intercepted request.
 */
export interface VendorContext {
  method: string
  /** URL the SDK originally targeted, before the client interceptor rewrote it. */
  originalUrl: string
  /** Query string on the request that reached the proxy. */
  query: URLSearchParams
  /** Lowercased request headers. */
  headers: Record<string, string>
  /** Parsed JSON body if Content-Type was application/json. Null otherwise. */
  jsonBody: any | null
  /** Raw body as text (form-encoded, JSON, or empty). */
  rawBody: string
  rule: DestinationRule
  serverConfig: ServerConfig
  /**
   * The deployment's two hashes, built once at construction. An adapter scrubs
   * its own payload, so it needs these; it must never build its own.
   */
  hasher: Hasher
}

/**
 * A concrete upstream request that the proxy should fire. Returning null
 * from an adapter means "drop this event" — the proxy will 204 and log it.
 */
export interface VendorForward {
  url: string
  method: string
  headers: Record<string, string>
  body: string
  /**
   * What the adapter's own scrub actually removed. Required: an adapter cannot
   * hand back a forward without saying what it took out, because this is what
   * the audit record is built from.
   */
  report: TransformationRecord[]
}

export type AdapterResult = VendorForward | null | { skip: true; reason: string }

export interface VendorAdapter {
  buildRequest(ctx: VendorContext): Promise<AdapterResult> | AdapterResult
}

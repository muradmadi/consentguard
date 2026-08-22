import { z } from 'zod'

/**
 * Consent State Schema
 * Represents the granular consent preferences for a user.
 */
export const ConsentStateSchema = z.object({
  userId: z.string(),
  purposes: z.record(z.string(), z.boolean()),
  timestamp: z.number().int(),
  metadata: z.record(z.string(), z.any()).optional(),
})

export type ConsentState = z.infer<typeof ConsentStateSchema>

/**
 * Transformation Action Types
 */
export const TransformationActionSchema = z.enum(['strip', 'hash', 'redact'])
export type TransformationAction = z.infer<typeof TransformationActionSchema>

/**
 * Destination Rule Schema
 * Defines how a specific analytics/marketing destination should be handled.
 */
export const DestinationRuleSchema = z.object({
  id: z.string(),
  category: z.string(), // e.g., 'analytics', 'marketing'
  endpoints: z.array(z.string()), // Domain patterns to match
  upstreamUrl: z.string().optional(), // Default URL to forward to
  transformations: z
    .array(
      z.object({
        path: z.string(), // JSON path (e.g., 'events.*.params.email')
        action: TransformationActionSchema,
        pattern: z.string().optional(), // Optional regex pattern for redaction
      }),
    )
    .default([]),
})

export type DestinationRule = z.infer<typeof DestinationRuleSchema>

/**
 * Ingest Request Schema
 */
export const IngestRequestSchema = z.object({
  destination: z.string(),
  payload: z.any(),
})

export type IngestRequest = z.infer<typeof IngestRequestSchema>

/**
 * Value-based PII Detectors
 * Declared rules catch known paths. These catch personal data by the shape of
 * the value, wherever it turns up in the payload — the fields nobody knew were
 * being sent. `us_ssn` is opt-in: national identifiers vary by jurisdiction and
 * a loose pattern damages more payloads than it protects.
 */
export const PiiDetectorSchema = z.enum(['email', 'phone', 'ipv4', 'ipv6', 'credit_card', 'us_ssn'])
export type PiiDetector = z.infer<typeof PiiDetectorSchema>

/**
 * Transformation Record Schema
 * Evidence that one transformation actually fired against a payload.
 * `matched` counts values changed — a wildcard path can exceed 1. Entries that
 * matched nothing are never recorded, and the value itself is never stored.
 * `detector` is present when the scanner found the data by value; its absence
 * means a declared rule path matched.
 */
export const TransformationRecordSchema = z.object({
  path: z.string(),
  action: TransformationActionSchema,
  matched: z.number().int().positive(),
  detector: PiiDetectorSchema.optional(),
})

export type TransformationRecord = z.infer<typeof TransformationRecordSchema>

/**
 * Audit Record Schema
 * The per-request proof. Every field is derived from what happened, not from
 * what a rule declared: `transformations` lists only what actually fired, and
 * `decision` is written after the upstream call resolves.
 */
export const AuditRecordSchema = z.object({
  timestamp: z.string(),
  userId: z.string(),
  destination: z.string(),
  decision: z.enum(['forwarded', 'blocked', 'buffered', 'failed']),
  reason: z.string(),
  purposesRequired: z.string().optional(),
  purposesGranted: z.array(z.string()).optional(),
  transformations: z.array(TransformationRecordSchema).default([]),
})

export type AuditRecord = z.infer<typeof AuditRecordSchema>

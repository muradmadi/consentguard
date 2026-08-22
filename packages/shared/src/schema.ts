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
 * Transformation Record Schema
 * Evidence that one declared transformation actually fired against a payload.
 * `matched` counts values changed — a wildcard path can exceed 1. Entries that
 * matched nothing are never recorded, and the value itself is never stored.
 */
export const TransformationRecordSchema = z.object({
  path: z.string(),
  action: TransformationActionSchema,
  matched: z.number().int().positive(),
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

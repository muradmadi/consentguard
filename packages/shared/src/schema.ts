import { z } from 'zod';

/**
 * Consent State Schema
 * Represents the granular consent preferences for a user.
 */
export const ConsentStateSchema = z.object({
  userId: z.string(),
  purposes: z.record(z.boolean()),
  timestamp: z.number().int(),
  metadata: z.record(z.any()).optional(),
});

export type ConsentState = z.infer<typeof ConsentStateSchema>;

/**
 * Transformation Action Types
 */
export const TransformationActionSchema = z.enum(['strip', 'hash', 'redact']);
export type TransformationAction = z.infer<typeof TransformationActionSchema>;

/**
 * Destination Rule Schema
 * Defines how a specific analytics/marketing destination should be handled.
 */
export const DestinationRuleSchema = z.object({
  id: z.string(),
  category: z.string(), // e.g., 'analytics', 'marketing'
  endpoints: z.array(z.string()), // Domain patterns to match
  upstreamUrl: z.string().optional(), // Default URL to forward to
  transformations: z.array(z.object({
    path: z.string(), // JSON path (e.g., 'events.*.params.email')
    action: TransformationActionSchema,
  })).default([]),
});

export type DestinationRule = z.infer<typeof DestinationRuleSchema>;

/**
 * Ingest Request Schema
 */
export const IngestRequestSchema = z.object({
  destination: z.string(),
  payload: z.any(),
});

export type IngestRequest = z.infer<typeof IngestRequestSchema>;

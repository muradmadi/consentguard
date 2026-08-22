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
 * What a hash is for. These are two different jobs and one digest cannot do both.
 *
 * `pseudonymize` is a keyed HMAC-SHA256 under a secret the deployment holds. A
 * plain SHA-256 of an email is dictionary-recoverable — hash a candidate list,
 * match the digests — so an unkeyed digest is not a pseudonym, and the EDPB's
 * pseudonymisation guidance asks for a key. Nothing at the vendor can reverse it
 * or join on it, which is the point. This is the default.
 *
 * `match_key` is the vendor's own contract: normalise, then unsalted SHA-256, so
 * the vendor can match the digest against its own. It is a weaker disclosure —
 * the same digest anyone else can compute from the address — so it is permitted
 * only where a destination rule names the field as a vendor match key, and the
 * audit records which of the two was applied.
 */
export const HashModeSchema = z.enum(['pseudonymize', 'match_key'])
export type HashMode = z.infer<typeof HashModeSchema>

/**
 * Which vendor normalisation to apply before a match key is computed. An
 * unsalted hash of an un-normalised value matches nothing either, so a
 * `match_key` transformation has to say which form the field holds.
 */
export const NormalizeFormatSchema = z.enum(['email', 'phone'])
export type NormalizeFormat = z.infer<typeof NormalizeFormatSchema>

/**
 * The category `getDefaultRule` gives a destination nobody declared, and the one
 * category `hasConsent` refuses outright. A rule that arrived malformed is not a
 * rule anyone consented to.
 */
export const UNKNOWN_DESTINATION_CATEGORY = 'unknown'

/**
 * One declared transformation on a destination rule.
 *
 * `mode` and `normalize` only mean anything to a hash, and a match key is only a
 * match key where the rule says so: an unsalted digest that leaves the building
 * has to be a deliberate, reviewable line in a rule rather than a global switch.
 */
export const TransformationSchema = z
  .object({
    path: z.string(), // JSON path (e.g., 'events.*.params.email')
    action: TransformationActionSchema,
    pattern: z.string().optional(), // Optional regex pattern for redaction
    mode: HashModeSchema.optional(), // Hash only. Defaults to pseudonymize.
    normalize: NormalizeFormatSchema.optional(), // Required by match_key.
  })
  .superRefine((transformation, ctx) => {
    if (transformation.action !== 'hash') {
      for (const field of ['mode', 'normalize'] as const) {
        if (transformation[field] !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: `${field} applies to a hash, not to ${transformation.action}`,
          })
        }
      }
      return
    }
    if (transformation.mode === 'match_key' && transformation.normalize === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['normalize'],
        message: 'match_key needs a normalize format, or the digest matches nothing',
      })
    }
  })

export type Transformation = z.infer<typeof TransformationSchema>

/**
 * Destination Rule Schema
 * Defines how a specific analytics/marketing destination should be handled.
 */
export const DestinationRuleSchema = z.object({
  id: z.string(),
  category: z.string(), // e.g., 'analytics', 'marketing'
  endpoints: z.array(z.string()), // Domain patterns to match
  upstreamUrl: z.string().optional(), // Default URL to forward to
  transformations: z.array(TransformationSchema).default([]),
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
 * means a declared rule path matched. `mode` accompanies a hash and says which
 * of the two hashes was applied: a match key is a digest the vendor can join on
 * and a pseudonym is not, so the two are materially different disclosures and
 * must not read identically. It is absent on records written before the modes
 * existed, which is what an absent field should mean rather than a default.
 */
export const TransformationRecordSchema = z.object({
  path: z.string(),
  action: TransformationActionSchema,
  matched: z.number().int().positive(),
  detector: PiiDetectorSchema.optional(),
  mode: HashModeSchema.optional(),
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
  decision: z.enum(['forwarded', 'blocked', 'failed']),
  reason: z.string(),
  purposesRequired: z.string().optional(),
  purposesGranted: z.array(z.string()).optional(),
  transformations: z.array(TransformationRecordSchema).default([]),
})

export type AuditRecord = z.infer<typeof AuditRecordSchema>

/**
 * Sealed Audit Record Schema
 * An audit record as it is written to the durable sink: the record plus its
 * position in the hash chain. `hash` is the digest of the record with `hash`
 * itself removed; `prevHash` is the digest of the record before it, so deleting
 * or editing an entry breaks the link and is detectable. A sealed record is a
 * superset of an `AuditRecord`, so anything reading the plain shape still works.
 */
export const SealedAuditRecordSchema = AuditRecordSchema.extend({
  seq: z.number().int().nonnegative(),
  prevHash: z.string().regex(/^[0-9a-f]{64}$/),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
})

export type SealedAuditRecord = z.infer<typeof SealedAuditRecordSchema>

/**
 * The state of the hash chain over the records the sink still holds.
 *
 * `truncated` is distinct from `broken` on purpose: retention deletes old
 * segments, which is a legitimate way for the chain to stop short of its
 * genesis. It is only `broken` when a record that should be there is missing,
 * altered, or out of order.
 */
export const ChainStatusSchema = z.object({
  status: z.enum(['intact', 'truncated', 'broken', 'unverified', 'unavailable']),
  checked: z.number().int().nonnegative(),
  head: z.object({ seq: z.number().int().nonnegative(), hash: z.string() }).nullable(),
  brokenAt: z.number().int().nonnegative().optional(),
  reason: z.string().optional(),
})

export type ChainStatus = z.infer<typeof ChainStatusSchema>

/**
 * One page of audit records, newest first. `nextCursor` is the `seq` to resume
 * below; `null` means the query reached the end of what the sink holds.
 * `scanned` is how many records were read to fill the page, so a filter that
 * matches nothing is distinguishable from a sink that holds nothing.
 */
export const AuditPageSchema = z.object({
  records: z.array(SealedAuditRecordSchema),
  nextCursor: z.number().int().nonnegative().nullable(),
  scanned: z.number().int().nonnegative(),
})

export type AuditPage = z.infer<typeof AuditPageSchema>

/**
 * Rule Health
 * Which of a destination's declared transformations have actually fired over
 * the retained window. `matched: 0` is a dead rule — a path that cannot exist
 * in the payloads that destination really sends. Derived from the audit, never
 * from the rule; `detected` reports what the value scan caught alongside it,
 * which is the same evidence read the other way round.
 */
export const RuleHealthSchema = z.object({
  destination: z.string(),
  declared: z.array(
    z.object({
      path: z.string(),
      action: TransformationActionSchema,
      mode: HashModeSchema.optional(),
      matched: z.number().int().nonnegative(),
      lastFiredAt: z.string().nullable(),
    }),
  ),
  detected: z.array(
    z.object({
      detector: PiiDetectorSchema,
      matched: z.number().int().nonnegative(),
    }),
  ),
})

export type RuleHealth = z.infer<typeof RuleHealthSchema>

export const RuleHealthReportSchema = z.object({
  destinations: z.array(RuleHealthSchema),
  recordsScanned: z.number().int().nonnegative(),
  scanLimit: z.number().int().positive(),
  /** True when the scan hit its ceiling, so the counts are a floor, not a total. */
  truncated: z.boolean(),
})

export type RuleHealthReport = z.infer<typeof RuleHealthReportSchema>

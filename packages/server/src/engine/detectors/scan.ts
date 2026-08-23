import type { PiiDetector, TransformationAction, TransformationRecord } from '@sluice/shared'
import { applyHash, type Hasher } from '../transformations/hash'
import { applyStrip } from '../transformations/strip'
import { DetectorDefinition, resolveDetectors } from './patterns'

const PLACEHOLDER = '[REDACTED]'

/**
 * Walk every string value in a payload and remove personal data by its shape,
 * whatever key it arrived under. Declared rules are the precise layer; this is
 * the layer that catches the field nobody knew was being sent.
 *
 * Mutates `payload` in place — callers hand it the clone `scrubPayload` already
 * made. Returns one record per detector that actually changed something, with
 * the concrete path it fired at. The matched value is never recorded.
 *
 * Everything this pass hashes is pseudonymised. A match key is a digest the
 * vendor can join on, and nothing found by shape at a path nobody declared has
 * been reviewed as a field the vendor is entitled to match against.
 */
export function scanPayload(
  payload: any,
  enabled: PiiDetector[],
  hasher: Hasher,
): TransformationRecord[] {
  const active = resolveDetectors(enabled)
  if (active.length === 0 || !payload || typeof payload !== 'object') return []

  const report: TransformationRecord[] = []
  walk(payload, '', active, report, hasher)
  return report
}

function walk(
  container: any,
  prefix: string,
  active: DetectorDefinition[],
  report: TransformationRecord[],
  hasher: Hasher,
): void {
  // Snapshot the keys: a whole-value strip deletes one as we go.
  const keys: (string | number)[] = Array.isArray(container)
    ? container.map((_, i) => i)
    : Object.keys(container)

  for (const key of keys) {
    const value = container[key]
    const path = prefix ? `${prefix}.${key}` : String(key)

    if (typeof value === 'string' || typeof value === 'number') {
      inspect(container, key, path, active, report, hasher)
    } else if (value && typeof value === 'object') {
      walk(value, path, active, report, hasher)
    }
  }
}

/**
 * Run the detectors against one value, which may be a number.
 *
 * Numbers used to be skipped, on the reasoning that every detector needs
 * punctuation or an issuer prefix so a bare digit run is an id. That is true of
 * five of the six: email and both IP forms need separators, phone needs a
 * leading `+` or real separators, and an SSN needs its hyphens. None of them can
 * fire on a number even when it is spelled out.
 *
 * `credit_card` is the exception, and the one that matters. Its pattern matches
 * a bare run of digits behind an issuer prefix and a Luhn check, and a 16-digit
 * card is a safe JSON integer — so `{"pan": 4111111111111111}` round-tripped
 * intact while the same value in quotes was removed. Protection is not supposed
 * to depend on which JSON type a vendor's SDK happened to use.
 *
 * Luhn plus the issuer prefix is what keeps this off ordinary ids: millisecond
 * and microsecond timestamps cannot match at all, because no issuer prefix
 * begins with `1`, and neither can anything shorter than thirteen digits.
 */
function inspect(
  container: any,
  key: string | number,
  path: string,
  active: DetectorDefinition[],
  report: TransformationRecord[],
  hasher: Hasher,
): void {
  for (const detector of active) {
    const raw = container[key]
    // Re-read per detector: an earlier one may have replaced the value, and a
    // whole-value action returns below rather than falling through to here.
    const value = typeof raw === 'number' ? numericText(raw) : raw
    if (typeof value !== 'string' || value === '') return

    detector.pattern.lastIndex = 0
    const matches = [...value.matchAll(detector.pattern)].filter(
      (m) => !detector.validate || detector.validate(m[0]),
    )
    if (matches.length === 0) continue

    if (matches.length === 1 && matches[0][0] === value.trim()) {
      report.push({
        path,
        ...replaceWholeValue(container, key, detector.action, hasher),
        matched: 1,
        detector: detector.id,
      })
      // The value is now a digest or gone; there is nothing left to scan.
      return
    }

    let matched = 0
    const redacted = value.replace(detector.pattern, (m) => {
      if (detector.validate && !detector.validate(m)) return m
      matched++
      return PLACEHOLDER
    })
    if (matched === 0) continue

    container[key] = redacted
    report.push({ path, action: 'redact', matched, detector: detector.id })
  }
}

/**
 * Apply a detector's action to a value it matched end to end, and report the
 * action that was actually taken rather than the one that was configured.
 */
function replaceWholeValue(
  container: any,
  key: string | number,
  action: TransformationAction,
  hasher: Hasher,
): { action: TransformationAction; mode?: 'pseudonymize' } {
  if (action === 'hash') {
    applyHash(container, String(key), hasher, { mode: 'pseudonymize' })
    return { action: 'hash', mode: 'pseudonymize' }
  }

  // Deleting an array element shifts every index after it, and vendors index
  // into these arrays. Inside an array a strip becomes a redaction.
  if (action === 'strip' && !Array.isArray(container)) {
    applyStrip(container, String(key))
    return { action: 'strip' }
  }

  container[key] = PLACEHOLDER
  return { action: 'redact' }
}

/**
 * A number as the text a detector sees, or null when there is nothing to match.
 *
 * Exponential notation (`1e21`) and a non-finite value carry no identifier and
 * would only give a pattern a shape to trip over, so neither is scanned.
 */
function numericText(value: number): string | null {
  if (!Number.isFinite(value)) return null
  const text = String(value)
  return text.includes('e') || text.includes('E') ? null : text
}

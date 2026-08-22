import type { PiiDetector, TransformationAction, TransformationRecord } from '@sluice/shared'
import { applyHash } from '../transformations/hash'
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
 */
export function scanPayload(payload: any, enabled: PiiDetector[]): TransformationRecord[] {
  const active = resolveDetectors(enabled)
  if (active.length === 0 || !payload || typeof payload !== 'object') return []

  const report: TransformationRecord[] = []
  walk(payload, '', active, report)
  return report
}

function walk(
  container: any,
  prefix: string,
  active: DetectorDefinition[],
  report: TransformationRecord[],
): void {
  // Snapshot the keys: a whole-value strip deletes one as we go.
  const keys: (string | number)[] = Array.isArray(container)
    ? container.map((_, i) => i)
    : Object.keys(container)

  for (const key of keys) {
    const value = container[key]
    const path = prefix ? `${prefix}.${key}` : String(key)

    if (typeof value === 'string') {
      inspect(container, key, path, active, report)
    } else if (value && typeof value === 'object') {
      walk(value, path, active, report)
    }
    // Numbers are left alone deliberately: every detector here requires
    // punctuation or an issuer prefix, so a bare number is an id, not PII.
  }
}

function inspect(
  container: any,
  key: string | number,
  path: string,
  active: DetectorDefinition[],
  report: TransformationRecord[],
): void {
  for (const detector of active) {
    const value = container[key]
    if (typeof value !== 'string' || value === '') return

    detector.pattern.lastIndex = 0
    const matches = [...value.matchAll(detector.pattern)].filter(
      (m) => !detector.validate || detector.validate(m[0]),
    )
    if (matches.length === 0) continue

    if (matches.length === 1 && matches[0][0] === value.trim()) {
      report.push({
        path,
        action: replaceWholeValue(container, key, detector.action),
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
): TransformationAction {
  if (action === 'hash') {
    applyHash(container, String(key))
    return 'hash'
  }

  // Deleting an array element shifts every index after it, and vendors index
  // into these arrays. Inside an array a strip becomes a redaction.
  if (action === 'strip' && !Array.isArray(container)) {
    applyStrip(container, String(key))
    return 'strip'
  }

  container[key] = PLACEHOLDER
  return 'redact'
}

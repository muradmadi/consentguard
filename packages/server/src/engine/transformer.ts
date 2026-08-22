import {
  DestinationRule,
  PiiDetector,
  TransformationAction,
  TransformationRecord,
} from '@sluice/shared'
import { applyStrip } from './transformations/strip'
import { applyHash } from './transformations/hash'
import { applyRedact } from './transformations/redact'
import { DEFAULT_DETECTORS } from './detectors/patterns'
import { scanPayload } from './detectors/scan'

export interface ScrubResult {
  payload: any
  /**
   * What actually fired against this payload. A declared transformation whose
   * path was absent — or whose redaction pattern matched nothing — produces no
   * entry. This is the audit's only source of truth; never populate it from the
   * rule. The removed value itself is deliberately not recorded.
   */
  report: TransformationRecord[]
}

export interface ScrubOptions {
  /**
   * Value-based detectors to run after the declared rules. Defaults to the
   * standard set rather than to none: a caller that forgets to pass config
   * should scrub more than asked, never less.
   */
  detectors?: PiiDetector[]
}

/**
 * Scrub a payload in two passes: the destination's declared paths first, then a
 * value scan over whatever is left. The declared pass is precise and cheap and
 * runs first so that a field it already hashed cannot be re-detected.
 */
export function scrubPayload(
  payload: any,
  rule: DestinationRule,
  options: ScrubOptions = {},
): ScrubResult {
  const detectors = options.detectors ?? DEFAULT_DETECTORS
  const declared = rule.transformations ?? []

  if (declared.length === 0 && detectors.length === 0) {
    return { payload, report: [] }
  }

  // Clone payload to avoid mutating original
  const scrubbed = JSON.parse(JSON.stringify(payload))
  const report: TransformationRecord[] = []

  for (const transform of declared) {
    const matched = applyTransformation(
      scrubbed,
      transform.path,
      transform.action,
      transform.pattern,
    )
    if (matched > 0) {
      report.push({ path: transform.path, action: transform.action, matched })
    }
  }

  report.push(...scanPayload(scrubbed, detectors))

  return { payload: scrubbed, report }
}

/**
 * Apply a transformation action to a specific path in an object.
 * Supports '*' as a wildcard for array elements. Returns the number of values
 * actually changed, which a wildcard path can push above one.
 */
function applyTransformation(
  obj: any,
  path: string,
  action: TransformationAction,
  pattern?: string,
): number {
  const parts = path.split('.')
  let matched = 0

  function traverse(current: any, remainingParts: string[]) {
    if (!current || remainingParts.length === 0) return

    const [head, ...tail] = remainingParts

    if (head === '*') {
      if (Array.isArray(current)) {
        current.forEach((item) => traverse(item, tail))
      }
      return
    }

    if (tail.length === 0) {
      // Leaf node: Apply action
      let fired = false
      switch (action) {
        case 'strip':
          fired = applyStrip(current, head)
          break
        case 'hash':
          fired = applyHash(current, head)
          break
        case 'redact':
          fired = applyRedact(current, head, pattern)
          break
      }
      if (fired) matched++
    } else {
      // Branch node: Continue traversal
      if (current[head]) {
        traverse(current[head], tail)
      }
    }
  }

  traverse(obj, parts)
  return matched
}

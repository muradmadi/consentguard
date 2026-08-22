import { DestinationRule, TransformationAction, TransformationRecord } from '@sluice/shared'
import { applyStrip } from './transformations/strip'
import { applyHash } from './transformations/hash'
import { applyRedact } from './transformations/redact'

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

/**
 * Scrub a payload based on destination rules.
 */
export function scrubPayload(payload: any, rule: DestinationRule): ScrubResult {
  if (!rule.transformations || rule.transformations.length === 0) {
    return { payload, report: [] }
  }

  // Clone payload to avoid mutating original
  const scrubbed = JSON.parse(JSON.stringify(payload))
  const report: TransformationRecord[] = []

  for (const transform of rule.transformations) {
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

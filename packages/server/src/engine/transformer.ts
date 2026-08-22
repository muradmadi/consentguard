import { DestinationRule, TransformationAction } from '@sluice/shared'
import { applyStrip } from './transformations/strip'
import { applyHash } from './transformations/hash'
import { applyRedact } from './transformations/redact'

/**
 * Scrub a payload based on destination rules.
 */
export function scrubPayload(payload: any, rule: DestinationRule): any {
  if (!rule.transformations || rule.transformations.length === 0) {
    return payload
  }

  // Clone payload to avoid mutating original
  const scrubbed = JSON.parse(JSON.stringify(payload))

  for (const transform of rule.transformations) {
    applyTransformation(scrubbed, transform.path, transform.action, transform.pattern)
  }

  return scrubbed
}

/**
 * Apply a transformation action to a specific path in an object.
 * Supports '*' as a wildcard for array elements.
 */
function applyTransformation(
  obj: any,
  path: string,
  action: TransformationAction,
  pattern?: string,
) {
  const parts = path.split('.')

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
      switch (action) {
        case 'strip':
          applyStrip(current, head)
          break
        case 'hash':
          applyHash(current, head)
          break
        case 'redact':
          applyRedact(current, head, pattern)
          break
      }
    } else {
      // Branch node: Continue traversal
      if (current[head]) {
        traverse(current[head], tail)
      }
    }
  }

  traverse(obj, parts)
}

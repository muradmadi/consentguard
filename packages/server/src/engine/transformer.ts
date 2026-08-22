import {
  DestinationRule,
  PiiDetector,
  Transformation,
  TransformationAction,
  TransformationRecord,
} from '@sluice/shared'
import { applyStrip } from './transformations/strip'
import { applyHash, type Hasher } from './transformations/hash'
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
  /**
   * The two hashes, built once from the deployment's secret. Required rather
   * than defaulted: a hash with no key behind it is not a pseudonym, and there
   * is no safe value to invent here.
   */
  hasher: Hasher
}

/**
 * Scrub a payload in two passes: the destination's declared paths first, then a
 * value scan over whatever is left. The declared pass is precise and cheap and
 * runs first so that a field it already hashed cannot be re-detected.
 */
export function scrubPayload(
  payload: any,
  rule: DestinationRule,
  options: ScrubOptions,
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
    for (const outcome of applyTransformation(scrubbed, transform, options.hasher)) {
      report.push({ path: transform.path, ...outcome })
    }
  }

  report.push(...scanPayload(scrubbed, detectors, options.hasher))

  return { payload: scrubbed, report }
}

/** One group of values a declared transformation changed the same way. */
interface Outcome {
  action: TransformationAction
  matched: number
  mode?: TransformationRecord['mode']
}

/**
 * Apply a transformation action to a specific path in an object.
 * Supports '*' as a wildcard for array elements. Returns one group per outcome
 * actually produced, which is usually one: a wildcard path pushes `matched`
 * above one, and splits into two groups only when a declared match key held a
 * value that would not normalise and was removed instead.
 */
function applyTransformation(obj: any, transform: Transformation, hasher: Hasher): Outcome[] {
  const parts = transform.path.split('.')
  const groups = new Map<string, Outcome>()

  const record = (action: TransformationAction, mode?: TransformationRecord['mode']) => {
    const key = `${action}:${mode ?? ''}`
    const existing = groups.get(key)
    if (existing) existing.matched++
    else groups.set(key, { action, matched: 1, ...(mode ? { mode } : {}) })
  }

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
      switch (transform.action) {
        case 'strip':
          if (applyStrip(current, head)) record('strip')
          break
        case 'hash': {
          const outcome = applyHash(current, head, hasher, {
            // Unstated means pseudonymize. The weaker digest is never the
            // default: a rule has to ask for a match key by name.
            mode: transform.mode ?? 'pseudonymize',
            normalize: transform.normalize,
          })
          if (outcome) record(outcome.action, outcome.action === 'hash' ? outcome.mode : undefined)
          break
        }
        case 'redact':
          if (applyRedact(current, head, transform.pattern)) record('redact')
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
  return [...groups.values()]
}

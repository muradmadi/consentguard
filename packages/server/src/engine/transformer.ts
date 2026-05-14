import { DestinationRule, TransformationAction } from '@consentguard/shared';
import { createHash } from 'crypto';

/**
 * Scrub a payload based on destination rules.
 */
export function scrubPayload(payload: any, rule: DestinationRule): any {
  if (!rule.transformations || rule.transformations.length === 0) {
    return payload;
  }

  // Clone payload to avoid mutating original (though in proxy it's usually fresh)
  const scrubbed = JSON.parse(JSON.stringify(payload));

  for (const transform of rule.transformations) {
    applyTransformation(scrubbed, transform.path, transform.action);
  }

  return scrubbed;
}

/**
 * Apply a transformation action to a specific path in an object.
 * Supports '*' as a wildcard for array elements.
 */
function applyTransformation(obj: any, path: string, action: TransformationAction) {
  const parts = path.split('.');
  
  function traverse(current: any, remainingParts: string[]) {
    if (!current || remainingParts.length === 0) return;

    const [head, ...tail] = remainingParts;

    if (head === '*') {
      if (Array.isArray(current)) {
        current.forEach(item => traverse(item, tail));
      }
      return;
    }

    if (tail.length === 0) {
      // Leaf node: Apply action
      if (current[head] !== undefined) {
        if (action === 'strip') {
          delete current[head];
        } else if (action === 'hash') {
          if (typeof current[head] === 'string') {
            current[head] = createHash('sha256').update(current[head]).digest('hex');
          }
        } else if (action === 'redact') {
          current[head] = '[REDACTED]';
        }
      }
    } else {
      // Branch node: Continue traversal
      if (current[head]) {
        traverse(current[head], tail);
      }
    }
  }

  traverse(obj, parts);
}

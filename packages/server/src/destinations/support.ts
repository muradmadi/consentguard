import type { DestinationRule, DestinationRuleView, SupportLevel } from '@sluice/shared'
import { getAdapter } from './adapters'

/**
 * What this deployment can actually do with a destination.
 *
 * Derived from two facts and asserted by nobody: whether an adapter is
 * registered for the id, and what the rule says the vendor's beacon carries.
 * The registry used to list six destinations and serve one, which is the same
 * class of dishonesty as an audit built from a rule's declarations rather than
 * from what fired.
 *
 * An `opaque` transport with no adapter is `unsupported` because the payload
 * cannot be read, let alone scrubbed — forwarding it would produce an audit
 * record saying nothing was removed, which would be true and useless. Everything
 * else is `passthrough`: the scrubbed beacon reaches the endpoint the browser
 * was already targeting, which for a pixel or a plain JSON body is real support
 * rather than a fallback.
 */
export function supportFor(rule: DestinationRule): SupportLevel {
  if (getAdapter(rule.id)) return 'adapter'
  if (rule.transport === 'opaque') return 'unsupported'
  return 'passthrough'
}

/** A rule as an operator surface sees it, with its derived support level. */
export function withSupport(rule: DestinationRule): DestinationRuleView {
  return { ...rule, support: supportFor(rule) }
}

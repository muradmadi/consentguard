import { DestinationRule, DestinationRuleSchema } from '@sluice/shared';
import { StorageProvider } from './storage';
import * as registry from '../destinations/registry';

export class RuleManager {
  private storage: StorageProvider;
  private readonly KEY_PREFIX = 'rule_override:';

  constructor(storage: StorageProvider) {
    this.storage = storage;
  }

  /**
   * Check if a destination is supported (has registry rule or override).
   */
  async isSupported(id: string): Promise<boolean> {
    const override = await this.storage.get(`${this.KEY_PREFIX}${id}`);
    if (override) return true;
    return registry.getDestinationRule(id) !== null;
  }

  /**
   * Get a rule for a destination, applying overrides if they exist.
   */
  async getRule(id: string): Promise<DestinationRule> {
    // 1. Try to get override from storage
    const override = await this.storage.get(`${this.KEY_PREFIX}${id}`);
    
    if (override) {
      try {
        const parsed = JSON.parse(override);
        const result = DestinationRuleSchema.safeParse(parsed);
        if (result.success) {
          return result.data;
        }
        console.warn(`[Sluice] Invalid rule override for ${id}, falling back to registry.`);
      } catch (e) {
        console.error(`[Sluice] Error parsing rule override for ${id}:`, e);
      }
    }

    // 2. Fallback to registry or default
    return registry.getDestinationRule(id) || registry.getDefaultRule(id);
  }

  /**
   * List all rules (registry + active overrides).
   */
  async getAllRules(): Promise<DestinationRule[]> {
    const registryRules = registry.REGISTRY_KEYS;
    const rules: DestinationRule[] = [];

    for (const id of registryRules) {
      rules.push(await this.getRule(id));
    }

    return rules;
  }

  /**
   * Set an override for a rule.
   */
  async setOverride(id: string, rule: DestinationRule): Promise<void> {
    await this.storage.set(
      `${this.KEY_PREFIX}${id}`,
      JSON.stringify(rule)
    );
  }

  /**
   * Remove an override.
   */
  async deleteOverride(id: string): Promise<void> {
    await this.storage.del(`${this.KEY_PREFIX}${id}`);
  }
}

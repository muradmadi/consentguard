export interface CMPAdapter {
  /**
   * Identify the user ID from the provider's payload.
   */
  getUserId(payload: any): string | undefined

  /**
   * Map the provider's payload to Sluice's purpose categories.
   */
  getPurposes(payload: any): Record<string, boolean>

  /**
   * Extract additional metadata from the provider's payload.
   */
  getMetadata(payload: any): Record<string, any>
}

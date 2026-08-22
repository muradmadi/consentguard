export interface SluiceConfig {
  redis: {
    url: string
    keyPrefix: string
    cacheTimeout: number
  }
  proxy: {
    port: number
    authSecret?: string
    adminSecret?: string
    defaultConsent: 'allow' | 'deny'
  }
  destinations: Record<string, any>
}

export const defaultConfig: SluiceConfig = {
  redis: {
    url: 'redis://127.0.0.1:6379',
    keyPrefix: 'sluice_',
    cacheTimeout: 5000,
  },
  proxy: {
    port: 3000,
    defaultConsent: 'deny',
  },
  destinations: {},
}

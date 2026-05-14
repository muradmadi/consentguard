// ConsentGuard Client Interceptor (Skeleton)

export interface ClientConfig {
  proxyPath: string
  domains?: string[]
}

export function init(config?: Partial<ClientConfig>) {
  console.log('ConsentGuard client interceptor initialized.', config)
}

// Auto-init logic placeholder
if (typeof window !== 'undefined') {
  init((window as any).__consentGuardConfig)
}

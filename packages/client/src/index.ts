// ConsentGuard Client Interceptor (Skeleton)

export interface ClientConfig {
  proxyPath: string
  domains?: string[]
}

export function init(config?: Partial<ClientConfig>) {
  const mergedConfig: ClientConfig = {
    proxyPath: '/analytics/ingest',
    domains: ['*.google-analytics.com', 'api.mixpanel.com/track'],
    ...config,
  }

  console.log('ConsentGuard client interceptor active.', mergedConfig)

  if (typeof window !== 'undefined') {
    const originalFetch = window.fetch
    window.fetch = async (...args) => {
      const [resource] = args
      const url = typeof resource === 'string' ? resource : (resource as any).url

      const isMatch = mergedConfig.domains?.some((d) => 
        d.startsWith('*.') ? url.includes(d.slice(2)) : url.includes(d)
      )

      if (isMatch) {
        console.log(`[ConsentGuard] Intercepted request to: ${url}`)
        // Rerouting logic will be added here in the next step
      }

      return originalFetch(...args)
    }
  }
}

// Auto-init
if (typeof window !== 'undefined') {
  init((window as any).__consentGuardConfig)
}

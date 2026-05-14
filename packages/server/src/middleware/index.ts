// Express / Hono mountable middleware
export function consentProxyMiddleware() {
  return async (c: any, next: any) => {
    await next()
  }
}

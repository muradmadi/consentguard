# Configuration Interface & Environment Variables
ConsentGuard configuration follows a strict priority order: **defaults < `.consentguardrc` file < environment variables < programmatic config**. The final config is fully typed.
## Configuration File (`.consentguardrc.js` or `.consentguardrc.json`)
Place in project root. Example (JS):
```js
export default {
  redis: {
    url: 'redis://localhost:6379',
    keyPrefix: 'cg_',
    cacheTimeout: 5000, // consent cache TTL in ms
  },
  proxy: {
    port: 3000,
    authSecret: 's3cret',
    adminSecret: 'admin_s3cret',
    defaultConsent: 'deny', // 'allow' or 'deny' when user unknown
  },
  destinations: {
    ga4: {
      measurementId: 'G-XXXXXX',
      apiSecret: 'abc',
      consentCategory: 'analytics',
      strip: ['email', 'ip', 'user_id'],
    },
    mixpanel: {
      token: '...',
      consentCategory: 'analytics',
      strip: ['$email', '$ip'],
    },
    // ...
  }
}
```
## Environment Variables
Override file settings. All prefixed with `CG_`.
- `CG_REDIS_URL`
- `CG_PROXY_PORT`
- `CG_AUTH_SECRET`
- `CG_ADMIN_SECRET`
- `CG_DEFAULT_CONSENT` (`deny` / `allow`)
- `CG_DESTINATIONS_GA4_MEASUREMENT_ID` (nested configs flatten: `CG_DESTINATIONS_<NAME>_<KEY>`)
- `CG_DESTINATIONS_MIXPANEL_TOKEN`
## Programmatic Override (when used as middleware)
```js
app.use('/analytics', consentProxyMiddleware({
  redis: { url: process.env.REDIS_URL },
  destinations: { /* custom rules */ },
  defaultConsent: 'deny'
}))
```
Programmatic config wins over file and env.
## Built‑in Safe Defaults
- `redis.url`: `'redis://127.0.0.1:6379'`
- `proxy.port`: `3000`
- `defaultConsent`: `'deny'`
- If `authSecret` not set, proxy will **not start** and print error.
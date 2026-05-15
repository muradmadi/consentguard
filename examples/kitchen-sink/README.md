# ConsentGuard Kitchen Sink Demo

This example demonstrates the end-to-end flow of ConsentGuard: from client-side interception to server-side scrubbing and consent enforcement.

## 🚀 Getting Started

### 1. Start the Infrastructure
Ensure you have the ConsentGuard proxy and Redis running. You can use the `docker-compose.yml` in this directory:

```bash
docker-compose up -d
```

*Alternatively, if running locally without Docker:*
```bash
# In the root of the project
npm run build
# Start the proxy (ensure Redis is running at localhost:6379)
npx consentguard start
```

### 2. Open the Demo
Open `index.html` in your browser.

### 3. Test the Flow
1.  **Observe Blocking**: Try triggering a "Google Analytics" event without granting consent. The proxy will block it (204 or drop).
2.  **Grant Consent**: Toggle the "Analytics" switch and click "Update Preferences".
3.  **Observe Scrubbing**: Trigger the "Google Analytics" event again. Check the Proxy Audit Logs (or the Admin Dashboard) to see that PII (like Email and IP) has been scrubbed/hashed according to the registry rules.
4.  **Buffer & Replay**: Toggle consent *off*, trigger an event for a *new* user (you can change the User ID in the HTML), then toggle consent *on*. Watch the proxy replay the buffered request.

## 🛡️ Key Features Demonstrated
- **Universal Interception**: Intercepting `fetch` calls to various analytics endpoints.
- **Dynamic Policy Enforcement**: Consent state retrieved from Redis in real-time.
- **Rule-Based Scrubbing**: Applying SHA-256 hashing to PII fields.
- **Audit Trails**: Every decision is logged and visible in the Admin Dashboard.

# Workflow: Local End-to-End Sandbox Testing

## Context
Because ConsentGuard operates across the browser (client interceptor), a backend proxy (Hono server), and a database (Redis), testing individual units is not enough. Before merging complex PRs—especially those modifying the rule engine or client networking logic—you must verify the entire flow end-to-end.

Follow this workflow to spin up the local sandbox and trace an analytics event from the browser to the upstream destination.

---

## Step 1: Start the Infrastructure Stack
The sandbox requires Redis and the ConsentGuard Proxy running locally.
1. Open a terminal and navigate to the project root.
2. Start the local Redis instance (using Docker):
   ```bash
   docker run -p 6379:6379 -d redis:alpine
   ```
3. Start the ConsentGuard Proxy server in development mode:
   ```bash
   npm run dev -w packages/server
   ```
   *The proxy should start on `http://localhost:3000`.*

## Step 2: Seed the Consent State
Inject a test consent state into Redis for a dummy user.
1. Send a `PUT` request to the proxy to establish the consent state for a test user (`test_user_123`).
   ```bash
   curl -X PUT http://localhost:3000/consent/test_user_123 \
     -H "Authorization: Bearer admin_s3cret" \
     -H "Content-Type: application/json" \
     -d '{
       "purposes": {
         "necessary": true,
         "analytics": false,
         "marketing": true
       },
       "metadata": { "source": "sandbox" }
     }'
   ```
   *Note: In this scenario, `analytics` is denied, but `marketing` is allowed.*

## Step 3: Run the Client Sandbox
1. Open the local sandbox HTML file provided in the repository (e.g., `packages/client/sandbox/index.html`) in your browser. 
   *(You may need to serve it via a simple HTTP server like `npx serve packages/client/sandbox`).*
2. Ensure the sandbox initializes the ConsentGuard interceptor and sets the user ID to match the seeded state:
   ```javascript
   window.__consentGuardUserId = 'test_user_123';
   ```

## Step 4: Trigger Events and Observe
1. Open the Browser Developer Tools (Network Tab & Console).
2. Use the sandbox UI (or console) to fire a dummy analytics event (e.g., a mock GA4 or Mixpanel fetch request).
   ```javascript
   // Example simulated Mixpanel call
   fetch('https://api.mixpanel.com/track', {
     method: 'POST',
     body: JSON.stringify({ event: 'Test', properties: { $email: 'test@example.com' }})
   });
   ```
3. **Verify in Browser Network Tab:**
   - The request to `api.mixpanel.com` should be instantly aborted/mocked by the interceptor.
   - A new request should be sent to `http://localhost:3000/ingest/mixpanel`.

## Step 5: Trace the Server Logs
1. Switch to the terminal running the proxy server.
2. Observe the structured logs. You should see:
   - The incoming request identified as `mixpanel`.
   - The Redis lookup resolving the consent state (`analytics: false`).
   - The Rule Engine applying default transformations (stripping `$email`).
   - The final outbound fetch to the actual Mixpanel endpoint.
3. Verify that the proxy returned a `204 No Content` to the browser, indicating a successful proxy loop.

## Step 6: Teardown
When testing is complete:
1. Stop the proxy server (`Ctrl+C`).
2. Stop and remove the Redis container:
   ```bash
   docker stop <container_id> && docker rm <container_id>
   ```

---
description: Adding a new analytics or marketing destination to the ConsentGuard registry.
---
# Workflow: Adding a New Analytics Destination

## Context

ConsentGuard's value relies on its universal compatibility. To support a new analytics or marketing platform (e.g., GA4, Mixpanel, TikTok Pixel), we must configure the system to intercept its requests on the client and correctly scrub its payloads on the server.

Follow these steps to seamlessly add a new destination to the ConsentGuard registry.

---

## Step 1: Update the Client Interceptor

We need the client-side interceptor to detect and reroute outbound requests to the new destination.

1. Open `packages/client/src/patterns.ts` (or the equivalent file managing interception patterns).
2. Add a new regex or string pattern that matches the outbound API URL of the destination.
   - _Example: For Mixpanel, match `api.mixpanel.com/track`._
3. Map this pattern to a unique, lowercase destination identifier (e.g., `mixpanel`, `tiktok_pixel`).

## Step 2: Define the Server-Side Registry Configuration

The server needs to know how to handle payloads sent to this new destination identifier.

1. Create a new file in the server registry: `packages/server/src/destinations/<destination_id>.ts`.
2. Define and export a `DestinationConfig` object. It must include:
   - `name`: Human-readable name.
   - `requiredCategory`: The consent category needed to forward the event without stripping (e.g., `'analytics'` or `'marketing'`).
   - `defaultTransformations`: The safe-by-default scrubbing rules if consent is denied.
   - `upstreamEndpoint`: The actual API endpoint where the proxy should forward the scrubbed request.

   **Example Template:**

   ```typescript
   import { DestinationConfig } from '../../shared/config'

   export const mixpanel: DestinationConfig = {
     name: 'Mixpanel',
     requiredCategory: 'analytics',
     upstreamEndpoint: 'https://api.mixpanel.com/track',
     defaultTransformations: [
       { type: 'strip', fields: ['$email', '$ip', 'distinct_id'] },
       { type: 'hash', fields: ['device_id'] },
     ],
   }
   ```

## Step 3: Export the Destination

Make the new configuration available to the rule engine.

1. Open `packages/server/src/destinations/index.ts`.
2. Import the new destination file and export it as part of the unified registry object.

## Step 4: Write Integration Tests

Ensure the proxy correctly intercepts and scrubs the payload.

1. Create a test file: `packages/server/tests/destinations/<destination_id>.test.ts`.
2. Write tests covering three scenarios:
   - **Consent Granted:** Ensure no fields are stripped and the payload passes through intact.
   - **Consent Denied:** Ensure PII fields defined in `defaultTransformations` are correctly stripped/hashed.
   - **Malformed Payload:** Ensure the proxy safely rejects or handles bad JSON without crashing.

## Step 5: Update Meta Documentation

To maintain a clear audit trail of all supported tools, update the central destination index.

1. Open `.agent/meta/addeddestinations.md`.
2. Add a new entry for the destination. Include:
   - **ID**: The unique identifier used in code.
   - **Name**: Human-readable name.
   - **Category**: The required consent category.
   - **Transformations**: Summary of scrubbing rules (strip/hash).
   - **Patterns**: Client-side interception patterns.

## Step 6: Update README & Public Docs

Keep the community informed about supported platforms.

1. Update `README.md` to add the new tool to the list of "Supported Destinations."
2. (Optional) Provide a specific example payload in the destination registry documentation.

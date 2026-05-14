# Workflow: Integrating a New Consent Management Platform (CMP) Adapter

## Context
ConsentGuard acts as the enforcement layer, but it relies on external Consent Management Platforms (CMPs) like OneTrust, Cookiebot, or a custom built UI to capture the user's actual choices. 

To bridge this gap, we use "CMP Adapters"—small client-side scripts that listen for a specific CMP's consent update events and forward the standardized state to the ConsentGuard Proxy via the `PUT /consent/:userId` API.

Follow these steps to create a new CMP adapter.

---

## Step 1: Identify the CMP's Event Hook
Every major CMP fires a JavaScript event when a user updates their preferences.
1. Consult the target CMP's developer documentation to find their "Consent Updated" event hook.
   * *Example (OneTrust): Uses `Optanon.OnConsentChanged`.*
   * *Example (Cookiebot): Uses `window.addEventListener('CookiebotOnAccept', ...)`.*

## Step 2: Create the Adapter Script
1. Create a new file in `packages/client/src/adapters/<cmp_name>.ts`.
2. Write a function that initializes the listener and maps the CMP's specific category IDs to ConsentGuard's standard categories (`analytics`, `marketing`, `personalization`, `necessary`).

   **Example Template:**
   ```typescript
   import { updateConsentState } from '../api';

   export const initCMPAdapter = (proxyUrl: string, userId: string) => {
     // Replace with the specific CMP's event listener
     window.addEventListener('CMP_Consent_Event', (event: any) => {
       
       // Map CMP specific IDs to ConsentGuard categories
       const purposes = {
         necessary: true, // Usually always true
         analytics: event.detail.categories.includes('C002'), // CMP specific ID
         marketing: event.detail.categories.includes('C004'),
         personalization: event.detail.categories.includes('C003')
       };

       const metadata = {
         source: 'cmp_name',
         timestamp: Date.now()
       };

       // Send the payload to the ConsentGuard Proxy
       updateConsentState(proxyUrl, userId, purposes, metadata)
         .catch(err => console.error('ConsentGuard Sync Failed:', err));
     });
   };
   ```

## Step 3: Integrate and Expose the Adapter
Ensure developers can easily import and use the adapter without bloating the core interceptor script.
1. Do **not** bundle the adapter into the core `@consentguard/client` script to keep the core bundle size minimal (< 5KB).
2. Export the adapter as a separate entry point in the package configuration (e.g., `@consentguard/client/adapters/onetrust`).
3. Update the `package.json` exports map to reflect this new entry point.

## Step 4: Write Tests
1. Create a test file `packages/client/tests/adapters/<cmp_name>.test.ts`.
2. Mock the global `window` object and simulate the CMP firing its specific event.
3. Assert that `updateConsentState` is called with the correctly mapped categories and payload shape.

## Step 5: Update Documentation
1. Add a section in `README.md` under "Supported CMPs".
2. Provide a clear, copy-pasteable implementation example showing how a developer can import and initialize the new adapter alongside their existing CMP script.

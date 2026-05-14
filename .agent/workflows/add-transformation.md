---
description: Adding a new data transformation rule (e.g., hash, redact) to the rule engine.
---
# Workflow: Adding a New Transformation Rule

## Context

ConsentGuard's Rule Engine modifies outgoing payloads using transformations like `strip`, `hash`, or `redact`. When a new privacy requirement or edge case emerges (e.g., partial redaction, specific salting), we must extend the engine with a new transformation function.

Follow these steps to safely add a new data transformation pipeline function.

---

## Step 1: Define the Transformation Function

Transformations are pure functions that take a payload and a rule configuration, and return a modified payload.

1. Create a new file for the transformation: `packages/server/src/engine/transformations/<transformation_name>.ts`.
2. Write a pure, defensive function. Ensure it does not throw unhandled exceptions if the targeted field is missing or the wrong type.

   **Example Template:**

   ```typescript
   import { Payload } from '../../types'

   export interface RedactConfig {
     fields: string[]
     pattern: string
     replacement: string
   }

   export const applyRedact = (payload: Payload, config: RedactConfig): Payload => {
     const newPayload = { ...payload }
     // Implement logic to safely traverse newPayload, find 'fields',
     // and apply the regex 'pattern' with 'replacement'.
     return newPayload
   }
   ```

## Step 2: Register the Transformation in the Engine

1. Open `packages/server/src/engine/index.ts` (or the file responsible for the transformation pipeline).
2. Import your new function.
3. Map the transformation type string (e.g., `'redact'`) to your new function within the pipeline router.

## Step 3: Update Type Definitions

Ensure developers get autocomplete and type-safety when writing their `.consentguardrc.js` files.

1. Open `shared/config.ts`.
2. Update the `TransformationRule` union type to include your new configuration interface (e.g., `RedactConfig`).
   ```typescript
   export type TransformationRule = StripConfig | HashConfig | RedactConfig // <-- Added new type
   ```

## Step 4: Write Unit Tests

Transformations must be robust against unexpected data shapes.

1. Create a test file: `packages/server/tests/engine/transformations/<transformation_name>.test.ts`.
2. Write tests covering:
   - **Happy Path:** The transformation works exactly as expected on standard data.
   - **Missing Fields:** The transformation safely ignores fields that don't exist in the payload.
   - **Nested Fields:** (If applicable) The transformation works on deep object paths (e.g., `user.metadata.ip`).
   - **Type Mismatches:** The transformation safely ignores or skips fields that are not of the expected type (e.g., trying to regex replace a boolean).

## Step 5: Update Documentation

1. Update `README.md` or the advanced configuration docs to explain the new transformation.
2. Provide a clear JSON/YAML example of how a developer can use this transformation in their `.consentguardrc.js` file.

---
description: Standardized process for releasing monorepo packages with bundle size verification.
---
# Workflow: Monorepo Release & Bundle Verification

## Context

ConsentGuard is distributed as a monorepo containing multiple packages (`@consentguard/client`, `@consentguard/server`, and the CLI). A critical requirement of this project is that the client-side interceptor remains extremely lightweight (**under 5KB gzipped**) so it does not impact page load performance.

Releasing an update requires strict validation to ensure cross-package compatibility and strict adherence to size limits.

---

## Step 1: Pre-Flight Checks & Quality Gates

Before initiating a version bump, ensure the codebase is pristine.

1. Run linting across all workspaces:
   ```bash
   npm run lint --workspaces
   ```
2. Run the unified test suite:
   ```bash
   npm run test --workspaces
   ```
   _Ensure all server unit tests, engine pipeline tests, and client adapter tests pass._

## Step 2: Bundle Size Verification (CRITICAL)

The `@consentguard/client` package must never exceed 5KB gzipped.

1. Build the client package:
   ```bash
   npm run build -w packages/client
   ```
2. Run the size limit checker (e.g., using `size-limit` or a custom script):
   ```bash
   npm run check-size -w packages/client
   ```
3. **Action:** If the size limit fails, the release **must be aborted**. Review recent commits to the client package, identify bloated dependencies or unoptimized code, and refactor before proceeding.

## Step 3: Version Bumping

ConsentGuard uses synced versions across packages to avoid compatibility matrix issues.

1. Use a tool like Changesets or Lerna to apply version bumps based on conventional commits.
   ```bash
   npx changeset version
   ```
2. Review the generated `CHANGELOG.md` files in each package to ensure release notes are accurate and clearly communicate breaking changes.
3. Commit the version bumps and changelogs:
   ```bash
   git commit -am "chore(release): version packages"
   ```

## Step 4: Build Server & CLI Artifacts

1. Build the server package (compiling TypeScript to the target runtime format):
   ```bash
   npm run build -w packages/server
   ```
2. Build the CLI package:
   ```bash
   npm run build -w packages/cli
   ```

## Step 5: Publish Packages

1. Authenticate with npm.
2. Publish the monorepo workspaces:
   ```bash
   npm publish --workspaces --access public
   ```
   _Note: Ensure you are publishing the `dist` directories and not raw TypeScript files by verifying the `files` array in each `package.json`._

## Step 6: Docker Image Deployment

The server is also distributed as a Docker image for standalone deployment.

1. Build the Docker image, tagging it with the new version:
   ```bash
   docker build -t consentguard/server:latest -t consentguard/server:v<VERSION> .
   ```
2. Push the images to the container registry:
   ```bash
   docker push consentguard/server --all-tags
   ```

## Step 7: GitHub Release

1. Create a new Release on GitHub targeting the release commit.
2. Tag it with `v<VERSION>`.
3. Copy the compiled release notes from the root `CHANGELOG.md` into the GitHub release description.

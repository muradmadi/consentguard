#!/usr/bin/env node
/**
 * Fail the build if a credential made it into a build artifact.
 *
 * The dashboard bundle used to contain the admin bearer as a string literal:
 * `VITE_ADMIN_SECRET` is inlined by Vite at build time, and the proxy serves
 * that bundle unauthenticated at /dashboard/*. Nothing in the gate noticed,
 * because the code was correct — it was the deployment shape that leaked. So
 * the check looks at what actually ships rather than at what the source says.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PACKAGES = join(ROOT, 'packages')

/** Extensions worth reading: text a bundler emits. */
const TEXT = /\.(js|mjs|cjs|css|html|json|map|txt)$/

const PATTERNS = [
  // The token that used to be compiled in, and anything shaped like it.
  { name: 'a literal admin secret', re: /admin[-_]?secret\s*[:=]\s*['"][^'"]+['"]/i },
  { name: 'the historic dev admin token', re: /dev-admin-secret/i },
  // A build-time secret env var is inlined by name-substitution, so its
  // presence in output means the value went with it.
  { name: 'an inlined VITE_*_SECRET / VITE_*_TOKEN', re: /VITE_[A-Z0-9_]*(SECRET|TOKEN|KEY)/ },
  { name: 'a GA4 api_secret value', re: /api_secret=[A-Za-z0-9_-]{8,}/ },
]

function* files(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) yield* files(path)
    else if (TEXT.test(entry)) yield path
  }
}

const findings = []
for (const pkg of readdirSync(PACKAGES)) {
  for (const file of files(join(PACKAGES, pkg, 'dist'))) {
    const contents = readFileSync(file, 'utf8')
    for (const { name, re } of PATTERNS) {
      const match = contents.match(re)
      if (match) findings.push({ file: file.replace(ROOT, ''), name, at: match[0].slice(0, 60) })
    }
  }
}

if (findings.length > 0) {
  console.error('A build artifact contains something secret-shaped:\n')
  for (const f of findings) console.error(`  ${f.file}\n    ${f.name}: ${f.at}`)
  console.error('\nSecrets belong in the runtime environment, never in a shipped bundle.')
  process.exit(1)
}

console.log('No secret-shaped values in packages/*/dist.')

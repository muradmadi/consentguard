import { defineConfig } from 'tsup'
import pkg from './package.json'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  clean: true,
  // Inline the package version so `sluice --version` can never drift from it.
  define: { __CLI_VERSION__: JSON.stringify(pkg.version) },
})

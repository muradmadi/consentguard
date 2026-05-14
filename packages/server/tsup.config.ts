import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/middleware/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
})

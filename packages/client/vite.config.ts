import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'Sluice',
      fileName: (format) => `sluice.${format}.js`,
      formats: ['es', 'cjs', 'iife'],
    },
    minify: 'esbuild',
    emptyOutDir: true,
  },
})

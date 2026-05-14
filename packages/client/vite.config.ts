import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ConsentGuard',
      fileName: (format) => `consentguard.${format}.js`,
      formats: ['es', 'cjs', 'iife'],
    },
    minify: 'terser',
    emptyOutDir: true,
  },
})

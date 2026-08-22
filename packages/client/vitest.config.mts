import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The interceptor patches browser networking primitives, so it needs a DOM.
    environment: 'jsdom',
    globals: true,
  },
})

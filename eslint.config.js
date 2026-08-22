import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.turbo/**'],
  },

  // Baseline for every TypeScript file in the monorepo.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      // The proxy deliberately handles untyped third-party payloads; `any` is
      // load-bearing in the destination adapters and Workers/CMP boundaries.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  // Server, CLI and shared run on Node.
  {
    files: ['packages/{server,cli,shared}/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // The client interceptor patches browser networking primitives.
  {
    files: ['packages/client/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Admin is a React SPA built by Vite.
  {
    files: ['packages/admin/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      globals: globals.browser,
    },
  },

  // Vite and ESLint configs are Node-side tooling.
  {
    files: ['**/*.config.{ts,js}'],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Vitest suites.
  {
    files: ['**/*.test.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.vitest },
    },
  },
)

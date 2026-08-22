/**
 * Pure configuration helpers for `sluice init`.
 *
 * Kept free of prompts and filesystem access so the interesting logic —
 * defaulting, origin parsing, compose rendering — is testable on its own.
 */

export interface InitAnswers {
  port?: number
  redisUrl?: string
  adminSecret?: string
  allowedOrigins?: string
}

export interface SluiceConfig {
  port: number
  redisUrl: string
  adminSecret: string
  allowedOrigins: string[]
}

export const INIT_DEFAULTS = {
  port: 3000,
  redisUrl: 'redis://localhost:6379',
  adminSecret: 'dev-admin-secret',
} as const

/** Parse a comma-separated origin list, dropping blanks and surrounding space. */
export function parseOrigins(raw?: string): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Build the config written to .sluicerc.json. Answers can be partial — a
 * cancelled prompt leaves fields undefined — so every field falls back to the
 * same default the prompt offered.
 */
export function buildConfig(answers: InitAnswers): SluiceConfig {
  return {
    port: answers.port ?? INIT_DEFAULTS.port,
    redisUrl: answers.redisUrl || INIT_DEFAULTS.redisUrl,
    adminSecret: answers.adminSecret || INIT_DEFAULTS.adminSecret,
    allowedOrigins: parseOrigins(answers.allowedOrigins),
  }
}

/** Render a docker-compose.yml that runs the proxy alongside Redis. */
export function renderCompose(config: SluiceConfig): string {
  return [
    'services:',
    '  proxy:',
    '    build: .',
    `    ports:`,
    `      - "${config.port}:${config.port}"`,
    '    environment:',
    `      - PORT=${config.port}`,
    '      - REDIS_URL=redis://redis:6379',
    `      - ADMIN_SECRET=${config.adminSecret}`,
    `      - SLUICE_ALLOWED_ORIGINS=${config.allowedOrigins.join(',')}`,
    '      - SLUICE_ENABLE_CACHE=true',
    '      - GA4_MEASUREMENT_ID=',
    '      - GA4_API_SECRET=',
    '    depends_on:',
    '      - redis',
    '  redis:',
    '    image: redis:7-alpine',
    '    volumes:',
    '      - redis_data:/data',
    'volumes:',
    '  redis_data:',
    '',
  ].join('\n')
}

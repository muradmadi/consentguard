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
  /** The key every pseudonymising hash is taken under. Never prompted for. */
  hashSecret: string
  allowedOrigins: string[]
}

export const INIT_DEFAULTS = {
  port: 3000,
  redisUrl: 'redis://localhost:6379',
} as const

/**
 * A fresh admin bearer for a new install.
 *
 * `init` used to offer a fixed development token, which every install that
 * accepted the default then shared with every other one. Generating it means
 * the operator has to lose it deliberately rather than by pressing enter.
 */
export function generateAdminSecret(): string {
  return randomSecret()
}

/**
 * The hash secret for a new install, always generated and never offered as a
 * default. The proxy refuses to start without one outside development, and a
 * shared default would make every install's pseudonyms comparable with every
 * other's — the property keyed hashing exists to remove.
 */
export function generateHashSecret(): string {
  return randomSecret()
}

function randomSecret(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
}

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
 * same default the prompt offered. An unanswered admin secret is generated
 * rather than defaulted, because there is no safe fixed value for one.
 */
export function buildConfig(answers: InitAnswers): SluiceConfig {
  return {
    port: answers.port ?? INIT_DEFAULTS.port,
    redisUrl: answers.redisUrl || INIT_DEFAULTS.redisUrl,
    adminSecret: answers.adminSecret || generateAdminSecret(),
    hashSecret: generateHashSecret(),
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
    `      - SLUICE_HASH_SECRET=${config.hashSecret}`,
    `      - SLUICE_ALLOWED_ORIGINS=${config.allowedOrigins.join(',')}`,
    '      - SLUICE_ENABLE_CACHE=true',
    // Blank on purpose: an adapter with no credentials skips the forward, which
    // is a visible empty line here rather than a variable nobody knew to set.
    '      - GA4_MEASUREMENT_ID=',
    '      - GA4_API_SECRET=',
    '      - META_PIXEL_ID=',
    '      - META_ACCESS_TOKEN=',
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

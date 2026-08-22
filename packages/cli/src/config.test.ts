import { describe, it, expect } from 'vitest'
import { buildConfig, parseOrigins, renderCompose, INIT_DEFAULTS } from './config'

describe('parseOrigins', () => {
  it('splits a comma-separated list', () => {
    expect(parseOrigins('https://a.example,https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('trims surrounding whitespace', () => {
    expect(parseOrigins(' https://a.example , https://b.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ])
  })

  it('drops empty entries and trailing commas', () => {
    expect(parseOrigins('https://a.example,,')).toEqual(['https://a.example'])
  })

  it('returns an empty list for empty or missing input', () => {
    expect(parseOrigins('')).toEqual([])
    expect(parseOrigins(undefined)).toEqual([])
  })
})

describe('buildConfig', () => {
  it('keeps the answers it is given', () => {
    const config = buildConfig({
      port: 8080,
      redisUrl: 'redis://cache:6379',
      adminSecret: 's3cret',
      allowedOrigins: 'https://app.example',
    })
    expect(config).toEqual({
      port: 8080,
      redisUrl: 'redis://cache:6379',
      adminSecret: 's3cret',
      allowedOrigins: ['https://app.example'],
    })
  })

  it('falls back to defaults when the prompt was cancelled', () => {
    const config = buildConfig({})
    expect(config.port).toBe(INIT_DEFAULTS.port)
    expect(config.redisUrl).toBe(INIT_DEFAULTS.redisUrl)
    expect(config.adminSecret).toBe(INIT_DEFAULTS.adminSecret)
    expect(config.allowedOrigins).toEqual([])
  })

  it('treats an empty origin list as allow-all rather than a blank entry', () => {
    expect(buildConfig({ allowedOrigins: '' }).allowedOrigins).toEqual([])
  })

  it('accepts port 0 without substituting the default', () => {
    expect(buildConfig({ port: 0 }).port).toBe(0)
  })
})

describe('renderCompose', () => {
  const config = buildConfig({
    port: 4000,
    adminSecret: 'topsecret',
    allowedOrigins: 'https://a.example,https://b.example',
  })
  const yaml = renderCompose(config)

  it('publishes the configured port', () => {
    expect(yaml).toContain('- "4000:4000"')
    expect(yaml).toContain('- PORT=4000')
  })

  it('threads the admin secret and origins into the environment', () => {
    expect(yaml).toContain('- ADMIN_SECRET=topsecret')
    expect(yaml).toContain('- SLUICE_ALLOWED_ORIGINS=https://a.example,https://b.example')
  })

  it('declares a redis service the proxy depends on', () => {
    expect(yaml).toContain('image: redis:7-alpine')
    expect(yaml).toMatch(/depends_on:\s*\n\s*- redis/)
  })

  it('ends with a trailing newline', () => {
    expect(yaml.endsWith('\n')).toBe(true)
  })
})

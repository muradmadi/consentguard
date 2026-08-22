import { describe, it, expect } from 'vitest'
import { getServerConfig } from './config'
import { DEFAULT_DETECTORS } from './engine/detectors/patterns'

const BASE = { NODE_ENV: 'test', ADMIN_SECRET: 'test-admin' }

describe('detector configuration', () => {
  it('enables the default set when SLUICE_DETECTORS is unset', () => {
    expect(getServerConfig(BASE).detectors).toEqual(DEFAULT_DETECTORS)
  })

  it('parses an explicit list, including the opt-in detectors', () => {
    const config = getServerConfig({ ...BASE, SLUICE_DETECTORS: 'email, us_ssn' })
    expect(config.detectors).toEqual(['email', 'us_ssn'])
  })

  it('disables the scan on off', () => {
    expect(getServerConfig({ ...BASE, SLUICE_DETECTORS: 'off' }).detectors).toEqual([])
  })

  it('drops an unknown detector name rather than the whole list', () => {
    const config = getServerConfig({ ...BASE, SLUICE_DETECTORS: 'email,passport' })
    expect(config.detectors).toEqual(['email'])
  })
})

/**
 * A default secret is a published secret. The old code had two of them —
 * `default-salt` in the config and `sluice-default-salt-12345` behind it in the
 * transformation — so a deployment that never set the variable pseudonymised
 * every email under a key printed in this repository.
 */
describe('hash secret', () => {
  it('takes the configured secret', () => {
    const config = getServerConfig({ ...BASE, SLUICE_HASH_SECRET: 'from-the-environment' })
    expect(config.hashSecret).toBe('from-the-environment')
  })

  it('refuses to start outside development without one', () => {
    expect(() => getServerConfig({ NODE_ENV: 'production', ADMIN_SECRET: 'admin' })).toThrow(
      /SLUICE_HASH_SECRET/,
    )
  })

  it('generates one per process in development rather than defaulting to a literal', () => {
    const secret = getServerConfig(BASE).hashSecret
    expect(secret).toBeTruthy()
    expect(secret).not.toMatch(/default/)
    expect(getServerConfig(BASE).hashSecret).toBe(secret)
  })

  it('reads the env it was handed, not the process it happens to run in', () => {
    const injected = getServerConfig({ ...BASE, SLUICE_HASH_SECRET: 'injected' })
    expect(injected.hashSecret).toBe('injected')
    expect(injected.hashSecret).not.toBe(process.env.SLUICE_HASH_SECRET)
  })
})

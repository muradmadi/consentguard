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

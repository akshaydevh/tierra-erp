import { afterEach, describe, expect, it } from 'vitest'
import { loadEnv } from './env'

const KEYS = ['NODE_ENV', 'DATABASE_URL', 'EVOLUTION_API_KEY', 'EVOLUTION_WEBHOOK_SECRET', 'DEFAULT_COUNTRY_CODE']
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]))

function withEnv(values: Record<string, string>) {
  for (const key of KEYS) delete process.env[key]
  Object.assign(process.env, { DATABASE_URL: 'postgres://localhost/tierra', ...values })
}

describe('loadEnv', () => {
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it('uses the shared dev secrets outside production', () => {
    withEnv({ NODE_ENV: 'development', EVOLUTION_API_KEY: '', EVOLUTION_WEBHOOK_SECRET: '' })
    expect(loadEnv()).toMatchObject({
      evolutionApiKey: 'tierra-evolution-key',
      webhookSecret: 'tierra-webhook-secret',
      defaultCountryCode: '91',
    })
  })

  it('refuses to start in production without private Evolution secrets', () => {
    withEnv({ NODE_ENV: 'production', EVOLUTION_API_KEY: 'real-key', EVOLUTION_WEBHOOK_SECRET: '' })
    expect(() => loadEnv()).toThrow('EVOLUTION_WEBHOOK_SECRET must be set to a private value in production')
    withEnv({ NODE_ENV: 'production', EVOLUTION_API_KEY: 'tierra-evolution-key', EVOLUTION_WEBHOOK_SECRET: 'real' })
    expect(() => loadEnv()).toThrow('EVOLUTION_API_KEY must be set to a private value in production')
    withEnv({ NODE_ENV: 'production', EVOLUTION_API_KEY: 'real-key', EVOLUTION_WEBHOOK_SECRET: 'real-secret' })
    expect(loadEnv()).toMatchObject({ evolutionApiKey: 'real-key', webhookSecret: 'real-secret' })
  })

  it('reads the default country code', () => {
    withEnv({ DEFAULT_COUNTRY_CODE: '+44' })
    expect(loadEnv().defaultCountryCode).toBe('44')
    withEnv({ DEFAULT_COUNTRY_CODE: 'india' })
    expect(() => loadEnv()).toThrow('DEFAULT_COUNTRY_CODE')
  })
})

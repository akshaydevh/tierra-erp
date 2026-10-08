import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEV_PASSWORD } from './db/seed-data'
import type { BotMode } from './whatsapp/parse'
import { DEFAULT_COUNTRY_CODE } from './whatsapp/people'

function loadDotEnv(): void {
  const path = join(process.cwd(), '.env')
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    if (process.env[key] !== undefined) continue
    process.env[key] = trimmed.slice(eq + 1).trim()
  }
}

export type Env = {
  databaseUrl: string
  port: number
  evolutionUrl: string
  evolutionApiKey: string
  webhookUrl: string
  webhookSecret: string
  openaiBaseUrl: string
  openaiApiKey: string
  openaiModel: string
  typesafeApiKey: string
  production: boolean
  /** SEED_DEMO=1 loads the demo users, customers and stock into an empty database. */
  seedDemo: boolean
  /** Null in production without SEED_PASSWORD: demo users must not get the shared dev password. */
  seedPassword: string | null
  workerEnabled: boolean
  botMode: BotMode
  /** Added to a 10-digit mobile number typed without a country code. */
  defaultCountryCode: string
}

const DEV_EVOLUTION_API_KEY = 'tierra-evolution-key'
const DEV_WEBHOOK_SECRET = 'tierra-webhook-secret'

/** The shared dev value is fine locally; production must set its own. */
function secretFrom(name: string, devValue: string, production: boolean): string {
  const value = process.env[name]
  if (production && (!value || value === devValue)) {
    throw new Error(`${name} must be set to a private value in production (not empty, not the dev default).`)
  }
  return value || devValue
}

function countryCodeFrom(value: string | undefined): string {
  if (!value) return DEFAULT_COUNTRY_CODE
  const digits = value.replace(/^\+/, '')
  if (!/^\d{1,3}$/.test(digits)) throw new Error('DEFAULT_COUNTRY_CODE must be 1 to 3 digits, e.g. 91')
  return digits
}

function botModeFrom(value: string | undefined): BotMode {
  if (!value || value === 'personal') return 'personal'
  if (value === 'dedicated') return 'dedicated'
  throw new Error('WHATSAPP_BOT_MODE must be personal or dedicated')
}

export function loadEnv(): Env {
  loadDotEnv()
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const production = process.env.NODE_ENV === 'production'
  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3002),
    evolutionUrl: process.env.EVOLUTION_URL ?? 'http://localhost:8081',
    evolutionApiKey: secretFrom('EVOLUTION_API_KEY', DEV_EVOLUTION_API_KEY, production),
    webhookUrl: process.env.EVOLUTION_WEBHOOK_URL ?? 'http://localhost:3002',
    webhookSecret: secretFrom('EVOLUTION_WEBHOOK_SECRET', DEV_WEBHOOK_SECRET, production),
    openaiBaseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
    openaiApiKey: process.env.OPENAI_API_KEY ?? '',
    openaiModel: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    typesafeApiKey: process.env.TYPESAFE_API_KEY ?? '',
    production,
    seedDemo: process.env.SEED_DEMO === '1',
    seedPassword: process.env.SEED_PASSWORD || (production ? null : DEV_PASSWORD),
    workerEnabled: process.env.WORKER_ENABLED !== '0',
    botMode: botModeFrom(process.env.WHATSAPP_BOT_MODE),
    defaultCountryCode: countryCodeFrom(process.env.DEFAULT_COUNTRY_CODE),
  }
}

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  poExtractBaseUrl: string
  poExtractApiKey: string
  poExtractModel: string
}

export function loadEnv(): Env {
  loadDotEnv()
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  return {
    databaseUrl,
    port: Number(process.env.PORT ?? 3002),
    evolutionUrl: process.env.EVOLUTION_URL ?? 'http://localhost:8081',
    evolutionApiKey: process.env.EVOLUTION_API_KEY ?? 'tierra-evolution-key',
    webhookUrl: process.env.EVOLUTION_WEBHOOK_URL ?? 'http://localhost:3002',
    webhookSecret: process.env.EVOLUTION_WEBHOOK_SECRET ?? 'tierra-webhook-secret',
    poExtractBaseUrl: process.env.PO_EXTRACT_BASE_URL ?? 'https://api.openai.com/v1',
    poExtractApiKey: process.env.PO_EXTRACT_API_KEY ?? '',
    poExtractModel: process.env.PO_EXTRACT_MODEL ?? 'gpt-4o-mini',
  }
}

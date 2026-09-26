import { serve } from '@hono/node-server'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { extractPurchaseOrder } from './agent/extract'
import { createApp } from './app'
import { DrizzleStore } from './db/drizzle-store'
import { migrate } from './db/migrate'
import * as schema from './db/schema'
import { seedIfEmpty } from './db/seed'
import { loadEnv } from './env'
import { HttpEvolution } from './whatsapp/evolution'

async function main() {
  const env = loadEnv()
  const sql = postgres(env.databaseUrl)
  await migrate(sql)
  const db = drizzle(sql, { schema })
  await seedIfEmpty(db)
  const app = createApp({
    store: new DrizzleStore(db),
    evolution: new HttpEvolution(env),
    extractPurchaseOrder: (pdf) => extractPurchaseOrder(pdf, env),
    now: () => new Date(),
    webhookSecret: env.webhookSecret,
    sessionTtlMs: 1000 * 60 * 60 * 24 * 14,
  })
  serve({ fetch: app.fetch, port: env.port }, () => {
    console.log(`tierra api listening on ${env.port}`)
  })
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

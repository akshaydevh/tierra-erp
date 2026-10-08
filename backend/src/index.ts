import { serve } from '@hono/node-server'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { extractPurchaseOrder } from './agent/extract'
import { createExtractTask } from './agent/extract-task'
import { createJudge } from './agent/judge'
import { createCompleteChat } from './agent/reply'
import { createApp, type AppDeps } from './app'
import { DrizzleStore } from './db/drizzle-store'
import { migrate } from './db/migrate'
import * as schema from './db/schema'
import { seedCustomerMaterials, seedIfEmpty, seedUnitsOfMeasure } from './db/seed'
import { loadEnv, type Env } from './env'
import { startWorker } from './jobs/worker'
import { requeueTaskNotices } from './tasks/notify'
import { HttpEvolution } from './whatsapp/evolution'

type Database = PostgresJsDatabase<typeof schema>

async function seedDemo(db: Database, env: Env): Promise<void> {
  if (!env.seedDemo) return
  if (!env.seedPassword) {
    throw new Error('SEED_DEMO=1 in production needs SEED_PASSWORD. Set it, or remove SEED_DEMO.')
  }
  await seedIfEmpty(db, env.seedPassword)
  await seedCustomerMaterials(db)
  await seedUnitsOfMeasure(db)
}

async function pointWebhookHere(deps: AppDeps): Promise<void> {
  try {
    const connection = await deps.store.getWhatsapp()
    if (connection.status === 'connected') await deps.evolution.ensureWebhook()
  } catch (error) {
    console.error('Could not point the WhatsApp webhook at this server', error)
  }
}

async function main() {
  const env = loadEnv()
  const sql = postgres(env.databaseUrl, { connection: { TimeZone: 'Asia/Kolkata' } })
  await migrate(sql)
  const db = drizzle(sql, { schema })
  await seedDemo(db, env)
  const store = new DrizzleStore(db)
  const deps: AppDeps = {
    store,
    evolution: new HttpEvolution(env),
    extractPurchaseOrder: (pdf) => extractPurchaseOrder(pdf, env),
    judgeIntent: createJudge(env),
    extractTask: createExtractTask(env),
    completeChat: createCompleteChat(env),
    enqueue: async (job) => Boolean(await store.enqueueJob(job)),
    botMode: env.botMode,
    now: () => new Date(),
    webhookSecret: env.webhookSecret,
    sessionTtlMs: 1000 * 60 * 60 * 24 * 14,
    secureCookie: env.production,
    defaultCountryCode: env.defaultCountryCode,
  }
  const app = createApp(deps)
  void pointWebhookHere(deps)
  const worker = env.workerEnabled ? startWorker(deps) : null
  if (worker) {
    void requeueTaskNotices(deps).catch((error: unknown) => console.error('Could not queue missed task notices', error))
  }
  if (!worker) console.log('job worker is off (WORKER_ENABLED=0)')
  const server = serve({ fetch: app.fetch, port: env.port }, () => {
    console.log(`tierra api listening on ${env.port} (${env.botMode} bot)`)
  })

  let stopping = false
  const shutdown = async (signal: string) => {
    if (stopping) return
    stopping = true
    console.log(`${signal} received, stopping`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await worker?.stop()
    await sql.end({ timeout: 5 })
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})

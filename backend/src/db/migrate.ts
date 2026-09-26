import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate as runMigrations } from 'drizzle-orm/postgres-js/migrator'
import type postgres from 'postgres'

export async function migrate(sql: postgres.Sql): Promise<void> {
  const db = drizzle(sql)
  await runMigrations(db, { migrationsFolder: join(process.cwd(), 'drizzle') })
}

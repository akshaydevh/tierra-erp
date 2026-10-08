import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'
import { DrizzleStore } from '../db/drizzle-store'
import * as schema from '../db/schema'

export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'drizzle')

const IMAGE = 'postgres:18-alpine'

type Journal = { entries: Array<{ idx: number; tag: string }> }

export type Connection = {
  sql: postgres.Sql
  db: PostgresJsDatabase<typeof schema>
  store: DrizzleStore
  close(): Promise<void>
}

export type Postgres = {
  /** Creates an empty database (or a copy of `template`) and returns its connection URL. */
  createDatabase(name: string, template?: string): Promise<string>
  stop(): Promise<void>
}

export type Harness = { postgres: Postgres; skipReason: null } | { postgres: null; skipReason: string }

function urlFor(container: StartedPostgreSqlContainer, database: string): string {
  const url = new URL(container.getConnectionUri())
  url.pathname = `/${database}`
  return url.toString()
}

/** Starts one Postgres container. Resolves with a skip reason instead when no container runtime is reachable. */
export async function startPostgres(): Promise<Harness> {
  let container: StartedPostgreSqlContainer
  try {
    container = await new PostgreSqlContainer(IMAGE).start()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/container runtime/i.test(message)) throw error
    return { postgres: null, skipReason: `Postgres tests skipped: Docker is not available (${message})` }
  }
  const admin = postgres(container.getConnectionUri(), { max: 1, onnotice: () => {} })
  return {
    skipReason: null,
    postgres: {
      async createDatabase(name, template) {
        const from = template ? admin`template ${admin(template)}` : admin``
        await admin`create database ${admin(name)} ${from}`
        return urlFor(container, name)
      },
      async stop() {
        await admin.end()
        await container.stop()
      },
    },
  }
}

export function connect(url: string): Connection {
  const sql = postgres(url, { max: 4, onnotice: () => {} })
  const db = drizzle(sql, { schema })
  return { sql, db, store: new DrizzleStore(db), close: () => sql.end() }
}

export async function runMigrations(url: string, migrationsFolder = MIGRATIONS_DIR): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await migrate(drizzle(sql), { migrationsFolder })
  } finally {
    await sql.end()
  }
}

/** Copies the migrations up to and including `lastIdx` into a temp folder. Call `remove` when done. */
export function migrationsThrough(lastIdx: number): { folder: string; remove(): void } {
  const folder = mkdtempSync(join(tmpdir(), 'tierra-migrations-'))
  mkdirSync(join(folder, 'meta'))
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8')) as Journal
  const entries = journal.entries.filter((entry) => entry.idx <= lastIdx)
  for (const entry of entries) {
    copyFileSync(join(MIGRATIONS_DIR, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`))
  }
  writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries }))
  return { folder, remove: () => rmSync(folder, { recursive: true, force: true }) }
}

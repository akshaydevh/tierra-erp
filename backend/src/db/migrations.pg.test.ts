import { afterAll, describe, expect, it } from 'vitest'
import { connect, migrationsThrough, runMigrations, startPostgres } from '../test/postgres'

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

describe.skipIf(!pg)('migrations on Postgres 18', () => {
  afterAll(async () => {
    await pg?.stop()
  })

  it('apply cleanly to an empty database', async () => {
    const url = await pg!.createDatabase('fresh')
    await runMigrations(url)
    const { sql, close } = connect(url)
    try {
      const tables = await sql<Array<{ name: string }>>`
        select table_name as name from information_schema.tables where table_schema = 'public'`
      expect(tables.map((row) => row.name)).toEqual(
        expect.arrayContaining(['users', 'tasks', 'whatsapp_messages', 'wa_identities', 'jobs', 'chat_context']),
      )
    } finally {
      await close()
    }
  })

  it('leaves exactly one admin when upgrading a database that had two', async () => {
    const url = await pg!.createDatabase('upgrade')
    const through0008 = migrationsThrough(8)
    try {
      await runMigrations(url, through0008.folder)
    } finally {
      through0008.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`
        insert into users (id, email, name, role, password_hash, created_at) values
          ('usr_joshy', 'joshy@tierra.test', 'Joshy', 'admin', 'x', '2026-01-01T00:00:00Z'),
          ('usr_alex', 'alex.thomas@tierra.test', 'Alex Thomas', 'admin', 'x', '2026-02-01T00:00:00Z'),
          ('usr_anju', 'anju@tierra.test', 'Anju', 'office', 'x', '2026-03-01T00:00:00Z')`
      await runMigrations(url)
      const users = await sql<Array<{ id: string; role: string }>>`select id, role from users order by id`
      expect(users).toEqual([
        { id: 'usr_alex', role: 'admin' },
        { id: 'usr_anju', role: 'office' },
        { id: 'usr_joshy', role: 'manager' },
      ])
    } finally {
      await close()
    }
  })

  it('demotes every admin but the oldest when Alex is not among them', async () => {
    const url = await pg!.createDatabase('upgrade_other')
    const through0008 = migrationsThrough(8)
    try {
      await runMigrations(url, through0008.folder)
    } finally {
      through0008.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`
        insert into users (id, email, name, role, password_hash, created_at) values
          ('usr_b', 'b@tierra.test', 'B', 'admin', 'x', '2026-02-01T00:00:00Z'),
          ('usr_a', 'a@tierra.test', 'A', 'admin', 'x', '2026-01-01T00:00:00Z')`
      await runMigrations(url)
      const users = await sql<Array<{ id: string; role: string }>>`select id, role from users order by id`
      expect(users).toEqual([
        { id: 'usr_a', role: 'admin' },
        { id: 'usr_b', role: 'manager' },
      ])
    } finally {
      await close()
    }
  })
})

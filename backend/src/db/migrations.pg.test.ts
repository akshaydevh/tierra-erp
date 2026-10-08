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
  it('adds country codes to stored phones, keeps one PDF per message and backfills assignedAt', async () => {
    const url = await pg!.createDatabase('upgrade_0010')
    const through0009 = migrationsThrough(9)
    try {
      await runMigrations(url, through0009.folder)
    } finally {
      through0009.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`
        insert into users (id, email, name, role, password_hash) values
          ('usr_a', 'a@tierra.test', 'A', 'admin', 'x'),
          ('usr_b', 'b@tierra.test', 'B', 'manager', 'x'),
          ('usr_c', 'c@tierra.test', 'C', 'office', 'x'),
          ('usr_d', 'd@tierra.test', 'D', 'office', 'x'),
          ('usr_e', 'e@tierra.test', 'E', 'office', 'x')`
      await sql`
        insert into account_relations (id, user_id, phone_number) values
          ('rel_a', 'usr_a', '9847012345'),
          ('rel_b', 'usr_b', '09847012346'),
          ('rel_c', 'usr_c', '919847012347'),
          ('rel_d', 'usr_d', '9847012347'),
          ('rel_e', 'usr_e', '4734222333')`
      await sql`
        insert into order_documents (id, message_id, filename, mime_type, content, created_at) values
          ('doc_1', 'wa-1', 'po.pdf', 'application/pdf', decode('00', 'hex'), '2026-01-01T00:00:00Z'),
          ('doc_2', 'wa-1', 'po.pdf', 'application/pdf', decode('00', 'hex'), '2026-01-02T00:00:00Z')`
      await sql`
        insert into tasks (id, title, category, created_by, created_at)
        values ('tsk_1', 'Old task', 'operations', 'usr_a', '2026-03-01T10:00:00Z')`
      await runMigrations(url)

      const phones = await sql<Array<{ user_id: string; phone_number: string }>>`
        select user_id, phone_number from account_relations order by user_id`
      expect(phones).toEqual([
        { user_id: 'usr_a', phone_number: '919847012345' },
        { user_id: 'usr_b', phone_number: '919847012346' },
        { user_id: 'usr_c', phone_number: '919847012347' },
        { user_id: 'usr_d', phone_number: '9847012347' },
        { user_id: 'usr_e', phone_number: '4734222333' },
      ])
      const documents = await sql<Array<{ id: string; message_id: string | null }>>`
        select id, message_id from order_documents order by id`
      expect(documents).toEqual([
        { id: 'doc_1', message_id: 'wa-1' },
        { id: 'doc_2', message_id: null },
      ])
      const [task] = await sql<Array<{ backfilled: boolean }>>`
        select assigned_at = '2026-03-01T10:00:00Z'::timestamptz as backfilled from tasks where id = 'tsk_1'`
      expect(task?.backfilled).toBe(true)
    } finally {
      await close()
    }
  })
})


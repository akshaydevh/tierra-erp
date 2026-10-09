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
      expect(tables.map((row) => row.name)).not.toContain('orders')
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

  it('drops the seed model, cancels open tasks about its orders and keeps stored PDFs and every P0 table', async () => {
    const url = await pg!.createDatabase('upgrade_0011')
    const through0010 = migrationsThrough(10)
    try {
      await runMigrations(url, through0010.folder)
    } finally {
      through0010.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`insert into users (id, email, name, role, password_hash) values ('usr_a', 'a@tierra.test', 'A', 'admin', 'x')`
      await sql`insert into customers (id, name, code) values ('cus_a', 'A Foods', 'A')`
      await sql`insert into orders (id, customer_id, po_number, status, source) values ('ord_a', 'cus_a', 'PO-1', 'open', 'whatsapp')`
      await sql`
        insert into order_documents (id, order_id, message_id, filename, mime_type, content)
        values ('doc_1', 'ord_a', 'wa-1', 'po.pdf', 'application/pdf', decode('00', 'hex'))`
      await sql`
        insert into tasks (id, title, category, created_by, status, subject_type, subject_id, completed_at) values
          ('tsk_1', 'Old task', 'operations', 'usr_a', 'todo', null, null, null),
          ('tsk_2', 'Confirm order', 'operations', 'usr_a', 'doing', 'order', 'ord_a', null),
          ('tsk_3', 'Buy cartons', 'procurement', 'usr_a', 'todo', 'pending_order', 'pnd_a', null),
          ('tsk_4', 'Shipped order', 'operations', 'usr_a', 'done', 'order', 'ord_b', '2026-03-01T10:00:00Z'),
          ('tsk_5', 'Review PO', 'operations', 'usr_a', 'todo', 'document', 'doc_1', null)`
      const through0011 = migrationsThrough(11)
      try {
        await runMigrations(url, through0011.folder)
      } finally {
        through0011.remove()
      }

      const tables = await sql<Array<{ name: string }>>`
        select table_name as name from information_schema.tables where table_schema = 'public' order by 1`
      expect(tables.map((row) => row.name)).toEqual([
        'account_relations',
        'chat_context',
        'jobs',
        'order_documents',
        'sessions',
        'tasks',
        'users',
        'wa_identities',
        'whatsapp_connection',
        'whatsapp_messages',
      ])
      expect(await sql`select id, message_id, filename from order_documents`).toEqual([
        { id: 'doc_1', message_id: 'wa-1', filename: 'po.pdf' },
      ])
      const columns = await sql<Array<{ name: string }>>`
        select column_name as name from information_schema.columns where table_name = 'order_documents'`
      expect(columns.map((row) => row.name)).not.toContain('order_id')
      expect(await sql`select id, status from tasks order by id`).toEqual([
        { id: 'tsk_1', status: 'todo' },
        { id: 'tsk_2', status: 'cancelled' },
        { id: 'tsk_3', status: 'cancelled' },
        { id: 'tsk_4', status: 'done' },
        { id: 'tsk_5', status: 'todo' },
      ])
    } finally {
      await close()
    }
  })

  it('adds party groups and WhatsApp groups: one owner per PAN or card, cascades and unmapping', async () => {
    const url = await pg!.createDatabase('upgrade_0012')
    await runMigrations(url)
    const { sql, close } = connect(url)
    try {
      await sql`insert into party_groups (id, name) values ('pty_a', 'Alpha'), ('pty_b', 'Beta')`
      await sql`
        insert into party_group_members (party_group_id, kind, value) values
          ('pty_a', 'pan', 'AAACZ1234A'), ('pty_a', 'card_code', 'ZC009'), ('pty_b', 'pan', 'AABCB5678B')`
      await expect(
        sql`insert into party_group_members (party_group_id, kind, value) values ('pty_b', 'pan', 'AAACZ1234A')`,
      ).rejects.toMatchObject({ code: '23505' })
      await expect(
        sql`insert into party_group_members (party_group_id, kind, value) values ('pty_b', 'gstin', 'X')`,
      ).rejects.toMatchObject({ code: '23514' })
      await expect(sql`insert into party_groups (id, name) values ('pty_c', 'Alpha')`).rejects.toMatchObject({
        code: '23505',
      })
      await sql`insert into wa_groups (jid, subject, party_group_id) values ('1@g.us', 'Alpha group', 'pty_a')`
      expect(await sql`select send_so from wa_groups`).toEqual([{ send_so: true }])
      await sql`delete from party_groups where id = 'pty_a'`
      expect(await sql`select party_group_id from wa_groups`).toEqual([{ party_group_id: null }])
      expect(await sql`select party_group_id, value from party_group_members`).toEqual([
        { party_group_id: 'pty_b', value: 'AABCB5678B' },
      ])
    } finally {
      await close()
    }
  })

  it('adds PO intake: stored PDFs keep their rows as other, one live PO per party / number / revision, cascades', async () => {
    const url = await pg!.createDatabase('upgrade_0013')
    const through0012 = migrationsThrough(12)
    try {
      await runMigrations(url, through0012.folder)
    } finally {
      through0012.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`insert into order_documents (id, message_id, filename, mime_type, content) values ('doc_1', 'm1', 'po.pdf', 'application/pdf', '\\x25504446')`
      await runMigrations(url)
      expect(await sql`select kind, version, subject_type from order_documents`).toEqual([{ kind: 'other', version: 1, subject_type: null }])
      await expect(sql`update order_documents set kind = 'invoice'`).rejects.toMatchObject({ code: '23514' })
      await sql`insert into party_groups (id, name) values ('pty_a', 'Alpha')`
      await sql`insert into customer_pos (id, party_group_id, po_no, document_id) values ('cpo_1', 'pty_a', '4400012345', 'doc_1')`
      await expect(sql`insert into customer_pos (id, party_group_id, po_no) values ('cpo_2', 'pty_a', '4400012345')`).rejects.toMatchObject({
        code: '23505',
      })
      await sql`insert into customer_pos (id, party_group_id, po_no, revision) values ('cpo_2', 'pty_a', '4400012345', 2)`
      await sql`update customer_pos set status = 'cancelled' where id = 'cpo_2'`
      await sql`insert into customer_pos (id, party_group_id, po_no, revision) values ('cpo_3', 'pty_a', '4400012345', 2)`
      await expect(sql`update customer_pos set status = 'approved' where id = 'cpo_3'`).rejects.toMatchObject({ code: '23514' })
      await sql`insert into customer_po_lines (customer_po_id, line_no, description, qty) values ('cpo_1', 1, 'chips', 2)`
      await sql`insert into inventory_checks (id, customer_po_id, kind, verdict) values ('chk_1', 'cpo_1', 'po', 'pass')`
      await sql`insert into inventory_check_lines (check_id, line_no, kind, item_code, need, status) values ('chk_1', 1, 'component', 'ZLAM', 5.76, 'ok')`
      await expect(
        sql`insert into customer_item_refs (id, party_group_id, item_code) values ('ref_1', 'pty_a', 'ZFG')`,
      ).rejects.toMatchObject({ code: '23514' })
      await sql`delete from customer_pos where id = 'cpo_1'`
      expect(await sql`select count(*)::int as n from inventory_check_lines`).toEqual([{ n: 0 }])
      expect(await sql`select count(*)::int as n from customer_po_lines`).toEqual([{ n: 0 }])
      await sql`delete from party_groups where id = 'pty_a'`
      expect(await sql`select id, party_group_id from customer_pos order by id`).toEqual([
        { id: 'cpo_2', party_group_id: null },
        { id: 'cpo_3', party_group_id: null },
      ])
    } finally {
      await close()
    }
  })

  it('marks P1-era PO PDFs as customer POs, allows the new TSO statuses and keeps one TSO per SAP sales order', async () => {
    const url = await pg!.createDatabase('upgrade_0015')
    const through0014 = migrationsThrough(14)
    try {
      await runMigrations(url, through0014.folder)
    } finally {
      through0014.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`insert into users (id, email, name, role, password_hash) values ('usr_a', 'a@tierra.test', 'A', 'admin', 'x')`
      await sql`
        insert into order_documents (id, message_id, filename, mime_type, content) values
          ('doc_po', 'm1', 'PO 4400012345.pdf', 'application/pdf', '\\x25504446'),
          ('doc_inv', 'm2', 'invoice.pdf', 'application/pdf', '\\x25504446'),
          ('doc_other', 'm3', 'rates.pdf', 'application/pdf', '\\x25504446')`
      // P1 raised "Review PO <file>" with subject ('document', id) for PO-looking PDFs
      await sql`
        insert into tasks (id, title, category, kind, subject_type, subject_id, created_by) values
          ('tsk_1', 'Review PO PO 4400012345.pdf', 'operations', 'review', 'document', 'doc_po', 'usr_a'),
          ('tsk_2', 'Check invoice.pdf', 'operations', 'review', 'document', 'doc_inv', 'usr_a'),
          ('tsk_3', 'Review PO rates.pdf', 'operations', 'todo', 'document', 'doc_other', 'usr_a')`
      await runMigrations(url)
      expect(await sql`select id, kind from order_documents order by id`).toEqual([
        { id: 'doc_inv', kind: 'other' },
        { id: 'doc_other', kind: 'other' },
        { id: 'doc_po', kind: 'customer_po' },
      ])
      const tso = (id: string, status: string, entry: number | null) =>
        sql`insert into sales_orders (id, doc_no, fy, seq, card_code, status, doc_date, basic_total, tax_total, total, sap_doc_entry)
            values (${id}, ${id}, '26-27', 1, 'ZN05', ${status}, '2026-04-02', 100, 5, 105, ${entry})`
      await tso('tso_1', 'approved_unsent', null)
      await tso('tso_2', 'in_sap', 120)
      await expect(tso('tso_3', 'in_sap', 120)).rejects.toMatchObject({ code: '23505' })
      await expect(tso('tso_4', 'keyed', null)).rejects.toMatchObject({ code: '23514' })
      expect(await sql`select cess, cancelled_at from sales_orders where id = 'tso_1'`).toEqual([{ cess: '0.00', cancelled_at: null }])
      expect(await sql`select column_name from information_schema.columns where table_name = 'whatsapp_messages' and column_name = 'answered_at'`).toHaveLength(1)
    } finally {
      await close()
    }
  })

  it('adds sales orders: one live TSO per customer PO, one approval per version, unique procurement requests', async () => {
    const url = await pg!.createDatabase('upgrade_0014')
    const through0013 = migrationsThrough(13)
    try {
      await runMigrations(url, through0013.folder)
    } finally {
      through0013.remove()
    }
    const { sql, close } = connect(url)
    try {
      await sql`insert into customer_pos (id, po_no) values ('cpo_1', '4400012345')`
      await runMigrations(url)
      expect(await sql`select delivery_term, payment_terms from customer_pos`).toEqual([{ delivery_term: null, payment_terms: null }])
      const so = (id: string, docNo: string, status = 'pending_approval') => sql`
        insert into sales_orders (id, doc_no, fy, seq, customer_po_id, card_code, status, doc_date, basic_total, tax_total, total)
        values (${id}, ${docNo}, '26-27', 1, 'cpo_1', 'ZN05', ${status}, '2026-04-02', 100, 5, 105)`
      await so('tso_1', 'TSO/26-27/0001')
      await expect(so('tso_2', 'TSO/26-27/0002')).rejects.toMatchObject({ code: '23505' })
      await expect(so('tso_3', 'TSO/26-27/0001', 'cancelled')).rejects.toMatchObject({ code: '23505' })
      await sql`update sales_orders set status = 'rejected' where id = 'tso_1'`
      await so('tso_2', 'TSO/26-27/0002')
      await expect(sql`update sales_orders set status = 'shipped' where id = 'tso_2'`).rejects.toMatchObject({ code: '23514' })
      await sql`insert into sales_order_lines (sales_order_id, line_no, item_code, qty, pcs, unit_price, amount, gst_pct, tax_amount) values ('tso_2', 1, 'ZFG', 2, 60, 36.2743, 2176.46, 5, 108.82)`
      expect(await sql`select unit_price from sales_order_lines`).toEqual([{ unit_price: '36.2743' }])
      await sql`insert into approvals (id, subject_type, subject_id, version) values ('apr_1', 'sales_order', 'tso_2', 1)`
      await expect(sql`insert into approvals (id, subject_type, subject_id, version) values ('apr_2', 'sales_order', 'tso_2', 1)`).rejects.toMatchObject({ code: '23505' })
      await expect(sql`update approvals set status = 'maybe'`).rejects.toMatchObject({ code: '23514' })
      const request = (id: string) => sql`
        insert into procurement_requests (id, subject_type, subject_id, item_code, qty, reason) values (${id}, 'sales_order', 'tso_2', 'ZLAM', 4, 'expedite')`
      await request('prq_1')
      await expect(request('prq_2')).rejects.toMatchObject({ code: '23505' })
      await expect(sql`insert into stock_adjustments (id, item_code, qty, status) values ('adj_1', 'ZLAM', 20, 'posted')`).rejects.toMatchObject({ code: '23514' })
      await sql`insert into doc_counters (series, fy) values ('TSO', '26-27')`
      expect(await sql`select next from doc_counters`).toEqual([{ next: 1 }])
      await sql`delete from sales_orders where id = 'tso_2'`
      expect(await sql`select count(*)::int as n from sales_order_lines`).toEqual([{ n: 0 }])
    } finally {
      await close()
    }
  })
})

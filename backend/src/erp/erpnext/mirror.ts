import mysql from 'mysql2/promise'
import type { SapSql } from '../../sap/db'

/**
 * Copies the ERPNext tables the read model needs from ERPNext's MariaDB into the Postgres schema `erpnext`, under
 * their own names ("tabSales Order", ...). The `sap` compat views (compat.ts) read these copies, and the `erp` views
 * read `sap`, so every query, agent tool and report keeps working on ERPNext data. Writes never go this way: they
 * go to ERPNext's REST API (client.ts), and the next sync brings them back.
 */

/** [table, optional MariaDB WHERE]: the rows the compat views read. */
export const MIRROR_TABLES: ReadonlyArray<readonly [string, string?]> = [
  ['tabItem'],
  ['tabItem Group'],
  ['tabItem Default', "parenttype = 'Item'"],
  ['tabWarehouse'],
  ['tabCustomer'],
  ['tabSupplier'],
  ['tabCustomer Group'],
  ['tabSupplier Group'],
  ['tabAddress'],
  ['tabDynamic Link', "parenttype = 'Address'"],
  ['tabBin'],
  ['tabBOM'],
  ['tabBOM Item', "parenttype = 'BOM'"],
  ['tabAccount'],
  ['tabSales Order'],
  ['tabSales Order Item'],
  ['tabSales Invoice'],
  ['tabSales Invoice Item'],
  ['tabSales Taxes and Charges'],
  ['tabPurchase Order'],
  ['tabPurchase Order Item'],
  ['tabPurchase Receipt'],
  ['tabPurchase Receipt Item'],
  ['tabPurchase Invoice'],
  ['tabPurchase Invoice Item'],
  ['tabPurchase Taxes and Charges'],
  ['tabPayment Entry'],
  ['tabPayment Entry Reference'],
  ['tabJournal Entry'],
  ['tabJournal Entry Account'],
  ['tabGL Entry', 'is_cancelled = 0'],
]

/** The documents that get a stable integer id (SAP's DocEntry when the record came from SAP). */
const ID_DOCTYPES = [
  'Sales Order',
  'Sales Invoice',
  'Purchase Order',
  'Purchase Receipt',
  'Purchase Invoice',
  'Payment Entry',
  'Journal Entry',
] as const

/** Indexes the compat views join on. */
const INDEXES: ReadonlyArray<readonly [string, string]> = [
  ['tabItem', 'name'],
  ['tabCustomer', 'name'],
  ['tabSupplier', 'name'],
  ['tabWarehouse', 'name'],
  ['tabAccount', 'name'],
  ['tabItem Default', 'parent'],
  ['tabDynamic Link', 'parent'],
  ['tabBOM Item', 'parent'],
  ['tabSales Order', 'name'],
  ['tabSales Order Item', 'parent'],
  ['tabSales Order Item', 'name'],
  ['tabSales Invoice', 'name'],
  ['tabSales Invoice Item', 'parent'],
  ['tabSales Invoice Item', 'so_detail'],
  ['tabSales Taxes and Charges', 'parent'],
  ['tabPurchase Order', 'name'],
  ['tabPurchase Order Item', 'parent'],
  ['tabPurchase Order Item', 'name'],
  ['tabPurchase Receipt', 'name'],
  ['tabPurchase Receipt Item', 'parent'],
  ['tabPurchase Receipt Item', 'name'],
  ['tabPurchase Invoice', 'name'],
  ['tabPurchase Invoice Item', 'parent'],
  ['tabPurchase Taxes and Charges', 'parent'],
  ['tabPayment Entry', 'name'],
  ['tabPayment Entry Reference', 'parent'],
  ['tabJournal Entry', 'name'],
  ['tabJournal Entry Account', 'parent'],
  ['tabGL Entry', 'voucher_no'],
  ['tabGL Entry', 'party'],
]

function pgType(dataType: string): string {
  switch (dataType.toLowerCase()) {
    case 'int':
    case 'bigint':
    case 'smallint':
    case 'tinyint':
    case 'mediumint':
      return 'bigint'
    case 'decimal':
    case 'double':
    case 'float':
      return 'numeric'
    case 'date':
      return 'date'
    case 'datetime':
    case 'timestamp':
      return 'timestamp'
    default:
      return 'text'
  }
}

const qi = (name: string) => `"${name.replaceAll('"', '""')}"`
const mi = (name: string) => `\`${name.replaceAll('`', '``')}\``

export type MirrorResult = { tables: number; rows: number; ms: number }

export class ErpnextMirror {
  private pool: mysql.Pool
  private ready = false

  constructor(
    private sql: SapSql,
    private erpDbUrl: string,
  ) {
    this.pool = mysql.createPool({ uri: erpDbUrl, connectionLimit: 2, dateStrings: true, decimalNumbers: false })
  }

  /**
   * An ERP_DB_URL without a database (mysql://user:pw@host:3306/) finds the ERPNext site database itself: the one
   * database that has tabSales Order. A hosted ERPNext names its site database at random.
   */
  private async useSiteDatabase(): Promise<void> {
    if (new URL(this.erpDbUrl).pathname.replace(/^\//, '')) return
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `select table_schema as s from information_schema.tables where table_name = 'tabSales Order'`,
    )
    if (rows.length !== 1) {
      throw new Error(`ERP_DB_URL names no database and ${rows.length} databases have ERPNext tables`)
    }
    await this.pool.end()
    this.pool = mysql.createPool({
      uri: this.erpDbUrl,
      database: rows[0].s,
      connectionLimit: 2,
      dateStrings: true,
      decimalNumbers: false,
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  private async columns(): Promise<Map<string, Array<{ name: string; type: string }>>> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `select table_name as t, column_name as c, data_type as d from information_schema.columns
       where table_schema = database() and table_name in (?) order by table_name, ordinal_position`,
      [MIRROR_TABLES.map(([t]) => t)],
    )
    const byTable = new Map<string, Array<{ name: string; type: string }>>()
    for (const row of rows) {
      const list = byTable.get(row.t) ?? []
      list.push({ name: row.c, type: pgType(row.d) })
      byTable.set(row.t, list)
    }
    return byTable
  }

  /** Creates the copies (and new columns: a custom field added later) and the id map. Safe to run again. */
  async prepare(): Promise<void> {
    await this.useSiteDatabase()
    const cols = await this.columns()
    const [{ has_schema }] = await this.sql`select to_regnamespace('erpnext') is not null as has_schema`
    if (!has_schema) await this.sql.unsafe(`create schema erpnext`)
    const have = new Set(
      (
        await this.sql<Array<{ t: string; c: string }>>`
          select table_name as t, column_name as c from information_schema.columns where table_schema = 'erpnext'`
      ).map((r) => `${r.t}\u0000${r.c}`),
    )
    const tables = new Set([...have].map((key) => key.split('\u0000')[0]))
    for (const [table] of MIRROR_TABLES) {
      const list = cols.get(table)
      if (!list) throw new Error(`ERPNext has no table ${table}`)
      if (!tables.has(table)) {
        await this.sql.unsafe(`create table erpnext.${qi(table)} (${list.map((c) => `${qi(c.name)} ${c.type}`).join(', ')})`)
        continue
      }
      // a custom field added in ERPNext since the last start
      for (const c of list.filter((c) => !have.has(`${table}\u0000${c.name}`))) {
        await this.sql.unsafe(`alter table erpnext.${qi(table)} add column ${qi(c.name)} ${c.type}`)
      }
    }
    const indexes = new Set(
      (await this.sql<Array<{ i: string }>>`select indexname as i from pg_indexes where schemaname = 'erpnext'`).map((r) => r.i),
    )
    for (const [table, column] of INDEXES) {
      const index = `${table}_${column}_idx`.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase()
      if (!indexes.has(index)) await this.sql.unsafe(`create index ${qi(index)} on erpnext.${qi(table)} (${qi(column)})`)
    }
    const [{ has_ids }] = await this.sql`select to_regclass('erpnext._ids') is not null as has_ids`
    if (!has_ids) await this.sql.unsafe(`
      create sequence if not exists erpnext._id_seq start 10000000;
      create table if not exists erpnext._ids (doctype text not null, name text not null, id bigint not null,
                                               primary key (doctype, name));
      create table if not exists erpnext._sync (id integer primary key, synced_at timestamptz not null,
                                                rows integer not null, ms integer not null);
    `)
    this.ready = true
  }

  /** Row count and last change per table: equal fingerprints mean ERPNext has not changed since the last copy. */
  async fingerprint(): Promise<string> {
    const parts: string[] = []
    for (const [table, where] of MIRROR_TABLES) {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `select count(*) as n, max(modified) as m from ${mi(table)}${where ? ` where ${where}` : ''}`,
      )
      parts.push(`${rows[0].n}:${rows[0].m}`)
    }
    return parts.join('|')
  }

  private last: string | null = null

  /** Copies only when ERPNext changed (or force). */
  async syncIfChanged(force = false): Promise<MirrorResult | null> {
    const print = await this.fingerprint()
    if (!force && print === this.last) return null
    const result = await this.sync()
    this.last = print
    return result
  }

  /**
   * Replaces every copy with ERPNext's current rows, gives new documents an id, and refreshes the erp
   * materialized views, all in one transaction: readers see the old data until the new data is complete.
   */
  async sync(): Promise<MirrorResult> {
    if (!this.ready) await this.prepare()
    const started = Date.now()
    const cols = await this.columns()
    const data = new Map<string, Array<Record<string, unknown>>>()
    for (const [table, where] of MIRROR_TABLES) {
      const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
        `select * from ${mi(table)}${where ? ` where ${where}` : ''}`,
      )
      data.set(table, rows)
    }
    let total = 0
    await this.sql.begin(async (tx) => {
      for (const [table] of MIRROR_TABLES) {
        const list = cols.get(table) ?? []
        const rows = data.get(table) ?? []
        // DELETE, not TRUNCATE: TRUNCATE's exclusive lock would block (and can deadlock) a reader mid-query
        await tx.unsafe(`delete from erpnext.${qi(table)}`)
        if (!rows.length) continue
        const names = list.map((c) => c.name)
        // stay well under Postgres' 65535 bind parameters per statement
        const batch = Math.max(1, Math.floor(30000 / names.length))
        for (let i = 0; i < rows.length; i += batch) {
          const chunk = rows.slice(i, i + batch)
          const params: unknown[] = []
          const values = chunk.map((row) => {
            const slots = names.map((name) => {
              const v = row[name]
              params.push(v === undefined || v === '' ? null : v)
              return `$${params.length}`
            })
            return `(${slots.join(',')})`
          })
          await tx.unsafe(
            `insert into erpnext.${qi(table)} (${names.map(qi).join(',')}) values ${values.join(',')}`,
            params as never[],
          )
        }
        total += rows.length
      }
      // ids: an imported document keeps its SAP DocEntry (custom_sap_ref "ORDR:5521"), a new one takes the sequence
      for (const doctype of ID_DOCTYPES) {
        await tx.unsafe(
          `insert into erpnext._ids (doctype, name, id)
           select $1, name, case when custom_sap_ref ~ '^(ORDR|OINV|OPOR|OPDN|OPCH|ORCT|OVPM):[0-9]+$'
                                 then split_part(custom_sap_ref, ':', 2)::bigint else nextval('erpnext._id_seq') end
           from erpnext.${qi(`tab${doctype}`)} order by creation, name
           on conflict do nothing`,
          [doctype],
        )
      }
      // journal transactions: one id per voucher
      await tx.unsafe(
        `insert into erpnext._ids (doctype, name, id)
         select 'GL', voucher_type || '/' || voucher_no, nextval('erpnext._id_seq')
         from (select voucher_type, voucher_no, min(creation) as c from erpnext."tabGL Entry"
               group by voucher_type, voucher_no) v
         order by c, voucher_type, voucher_no
         on conflict do nothing`,
      )
      const [{ has_erp }] = await tx`select to_regproc('erp.refresh') is not null as has_erp`
      if (has_erp) await tx`select erp.refresh()`
      await tx`insert into erpnext._sync (id, synced_at, rows, ms) values (1, now(), ${total}, ${Date.now() - started})
               on conflict (id) do update set synced_at = excluded.synced_at, rows = excluded.rows, ms = excluded.ms`
    })
    return { tables: MIRROR_TABLES.length, rows: total, ms: Date.now() - started }
  }
}

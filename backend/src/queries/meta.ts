import { day, timestamp, text, type SapSql } from '../sap/db'

export type Meta = {
  dataAsOf: string | null
  importedAt: string | null
  backup: string | null
}

const NOT_IMPORTED: Meta = { dataAsOf: null, importedAt: null, backup: null }

/** Postgres error codes for a missing schema or relation: the SAP import has not run on this database. */
const MISSING = new Set(['3F000', '42P01'])

export function isNotImported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && MISSING.has(code)
}

/** When the SAP data was taken and imported. All null until the first import. */
export async function importMeta(sql: SapSql): Promise<Meta> {
  try {
    const [row] = await sql`select backup, imported_at, data_as_of from erp.import_info`
    if (!row) return NOT_IMPORTED
    return { dataAsOf: day(row.data_as_of), importedAt: timestamp(row.imported_at), backup: text(row.backup) }
  } catch (error) {
    if (isNotImported(error)) return NOT_IMPORTED
    throw error
  }
}

/** The SAP data date, which "today", "this month" and "the last day" are measured from. */
export async function dataAsOf(sql: SapSql): Promise<string | null> {
  return (await importMeta(sql)).dataAsOf
}

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import postgres from 'postgres'

const BACKEND = join(__dirname, '..', '..')
export const SAP_SCHEMA_FILE = join(BACKEND, 'test', 'sap-schema.sql')
export const SAP_FIXTURE_FILE = join(BACKEND, 'test', 'sap-fixture.synthetic.sql')
export const ERP_SQL_DIR = join(BACKEND, '..', 'tools', 'sap-import', 'sql', 'erp')
/** The attachment schema the erp step creates first (erp.document_files reads it). */
export const ATT_SQL_FILE = join(BACKEND, '..', 'tools', 'sap-import', 'sql', 'att.sql')
/** The HR schema `run.py hr` writes ({s} is the schema name) and its synthetic rows. */
export const HR_SQL_FILE = join(BACKEND, '..', 'tools', 'sap-import', 'sql', 'hr.sql')
export const HR_FIXTURE_FILE = join(BACKEND, 'test', 'hr-fixture.synthetic.sql')

/**
 * Builds the SAP read model the way an import does, from the generated sap DDL, the synthetic fixture and the
 * real erp view SQL, then refreshes the materialized views.
 */
export async function loadSapFixture(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(readFileSync(SAP_SCHEMA_FILE, 'utf8'))
    await sql.unsafe(readFileSync(ATT_SQL_FILE, 'utf8'))
    await sql.unsafe('create schema erp')
    for (const file of readdirSync(ERP_SQL_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      await sql.unsafe(readFileSync(join(ERP_SQL_DIR, file), 'utf8'))
    }
    await sql.unsafe(readFileSync(SAP_FIXTURE_FILE, 'utf8'))
    await sql`select erp.refresh()`
  } finally {
    await sql.end()
  }
}

/** Adds schema hr the way `run.py hr` leaves it, with the synthetic HR rows. */
export async function loadHrFixture(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    await sql.unsafe(readFileSync(HR_SQL_FILE, 'utf8').replaceAll('{s}', 'hr'))
    await sql.unsafe(readFileSync(HR_FIXTURE_FILE, 'utf8'))
  } finally {
    await sql.end()
  }
}

import { cardFilter, day, num, type CardScope, type SapSql } from '../sap/db'
import { INVOICE_COLUMNS, invoiceRow, type InvoiceRow } from './sales'

export type DispatchKpis = { invoices: number; value: number; ewaybills: number; irnFailures: number }

export type DispatchDay = { date: string | null; kpis: DispatchKpis; rows: InvoiceRow[] }

export type DispatchCount = { date: string; invoices: number; value: number }

// Operational views leave out cancelled invoices and their cancellation mirrors.
const LIVE = 'not cancelled and not is_cancellation'

/**
 * Invoices dated on one day with their e-way bill and e-invoice (IRN) status, in the order they were raised, within
 * the caller's cards (the dashboard passes 'all').
 */
export async function dispatchDay(sql: SapSql, date: string | null, cards: CardScope): Promise<DispatchDay> {
  if (!date) return { date: null, kpis: { invoices: 0, value: 0, ewaybills: 0, irnFailures: 0 }, rows: [] }
  const rows = await sql`
    select ${sql.unsafe(INVOICE_COLUMNS)}
    from erp.invoices
    where doc_date = ${date}::date and ${sql.unsafe(LIVE)} ${cardFilter(sql, cards)}
    order by created_at, doc_entry`
  const invoices = rows.map(invoiceRow)
  return {
    date,
    kpis: {
      invoices: invoices.length,
      value: invoices.reduce((sum, row) => sum + row.total, 0),
      ewaybills: invoices.filter((row) => row.ewbNo != null && !row.ewbCancelled).length,
      irnFailures: invoices.filter((row) => row.irnStatus === 'failed').length,
    },
    rows: invoices,
  }
}

/** Invoice count and value per day in [from, to], for a date strip. Days without invoices are left out. */
export async function dispatchDays(sql: SapSql, from: string, to: string): Promise<DispatchCount[]> {
  const rows = await sql`
    select doc_date, count(*) as invoices, coalesce(sum(total), 0) as value
    from erp.invoices
    where doc_date between ${from}::date and ${to}::date and ${sql.unsafe(LIVE)}
    group by doc_date
    order by doc_date`
  return rows.map((row) => ({ date: day(row.doc_date) ?? '', invoices: num(row.invoices), value: num(row.value) }))
}

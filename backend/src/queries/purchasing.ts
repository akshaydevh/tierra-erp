import { day, monthStart, num, pageRequest, searchPattern, text, textArray, type Paged, type SapSql } from '../sap/db'

export const PROCUREMENT_TABS = ['pos', 'grns'] as const
export type ProcurementTab = (typeof PROCUREMENT_TABS)[number]

export type PurchaseOrderRow = {
  docEntry: number
  docNo: string
  docDate: string
  cardName: string
  total: number
  openValue: number
  status: string
  lineCount: number
  /** "CARTON-A 500 nos @ ₹12" for a one-line PO, "3 items" otherwise. */
  lineSummary: string | null
}

export type GrnRow = {
  docEntry: number
  docNo: string
  docDate: string
  cardName: string
  total: number
  freeIssue: boolean
  lineSummary: string | null
}

export type ProcurementKpis = { openPos: number; openPoValue: number; grnsMtd: number; freeIssueGrnsMtd: number }

export type ProcurementFilter = {
  q?: string | null
  /** purchase orders only: open, closed or cancelled */
  status?: string | null
  /** Document-date range, inclusive. */
  from?: string | null
  to?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}

const quantity = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })
const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

export function poLineSummary(
  lineCount: number,
  line: { item: string | null; qty: unknown; uom: string | null; price: unknown } | null,
): string | null {
  if (lineCount === 0) return null
  if (lineCount > 1 || !line?.item) return `${lineCount} items`
  const uom = line.uom ? ` ${line.uom}` : ''
  return `${line.item} ${quantity.format(num(line.qty))}${uom} @ ₹${rupees.format(num(line.price))}`
}

/** Open POs and what they still have to deliver; goods receipts this month (cancelled ones left out). */
export async function procurementKpis(sql: SapSql, asOf: string | null): Promise<ProcurementKpis> {
  const from = asOf ? monthStart(asOf) : null
  const [[pos], [grns]] = await Promise.all([
    sql`
      select count(*) filter (where status = 'open') as open_pos,
             coalesce(sum(open_value) filter (where status = 'open'), 0) as open_po_value
      from erp.purchase_orders`,
    sql`
      select count(*) as grns_mtd, count(*) filter (where free_issue) as free_issue_grns_mtd
      from erp.grns
      where not cancelled and doc_date between ${from}::date and ${asOf}::date`,
  ])
  return {
    openPos: num(pos?.open_pos),
    openPoValue: num(pos?.open_po_value),
    grnsMtd: num(grns?.grns_mtd),
    freeIssueGrnsMtd: num(grns?.free_issue_grns_mtd),
  }
}

/** Purchase orders, newest first. The search matches the number, vendor, vendor reference and line items. */
export async function purchaseOrders(sql: SapSql, filter: ProcurementFilter = {}): Promise<Paged<PurchaseOrderRow>> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where true
    ${
      like
        ? sql`and (p.doc_no ilike ${like} or p.card_name ilike ${like} or p.vendor_ref ilike ${like}
                   or exists (select 1 from erp.purchase_order_lines l
                              where l.doc_entry = p.doc_entry and (l.item_code ilike ${like} or l.item_name ilike ${like})))`
        : sql``
    }
    ${filter.status ? sql`and p.status = ${filter.status}` : sql``}
    ${filter.from ? sql`and p.doc_date >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and p.doc_date <= ${filter.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select p.doc_entry, p.doc_no, p.doc_date, p.card_name, p.total, p.open_value, p.status, p.line_count,
             l.item_code as line_item, l.qty as line_qty, l.uom as line_uom, l.price as line_price
      from erp.purchase_orders p
      left join erp.purchase_order_lines l on p.line_count = 1 and l.doc_entry = p.doc_entry
      ${where}
      order by p.doc_date desc, p.doc_entry desc
      limit ${pageSize} offset ${offset}`,
    sql`select count(*) as total from erp.purchase_orders p ${where}`,
  ])
  return {
    rows: rows.map((row) => ({
      docEntry: num(row.doc_entry),
      docNo: String(row.doc_no),
      docDate: day(row.doc_date) ?? '',
      cardName: String(row.card_name ?? ''),
      total: num(row.total),
      openValue: num(row.open_value),
      status: String(row.status),
      lineCount: num(row.line_count),
      lineSummary: poLineSummary(num(row.line_count), {
        item: text(row.line_item),
        qty: row.line_qty,
        uom: text(row.line_uom),
        price: row.line_price,
      }),
    })),
    total: num(count?.total),
    page,
    pageSize,
  }
}

/** Goods receipts (GRPO), newest first, cancelled ones and their mirrors left out. */
export async function goodsReceipts(sql: SapSql, filter: ProcurementFilter = {}): Promise<Paged<GrnRow>> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where not g.cancelled
    ${
      like
        ? sql`and (g.doc_no ilike ${like} or g.card_name ilike ${like} or g.vendor_ref ilike ${like}
                   or exists (select 1 from erp.grn_lines l
                              where l.doc_entry = g.doc_entry and (l.item_code ilike ${like} or l.item_name ilike ${like})))`
        : sql``
    }
    ${filter.from ? sql`and g.doc_date >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and g.doc_date <= ${filter.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select g.doc_entry, g.doc_no, g.doc_date, g.card_name, g.total, g.free_issue, g.line_summary
      from erp.grns g ${where}
      order by g.doc_date desc, g.doc_entry desc
      limit ${pageSize} offset ${offset}`,
    sql`select count(*) as total from erp.grns g ${where}`,
  ])
  return {
    rows: rows.map((row) => ({
      docEntry: num(row.doc_entry),
      docNo: String(row.doc_no),
      docDate: day(row.doc_date) ?? '',
      cardName: String(row.card_name ?? ''),
      total: num(row.total),
      freeIssue: Boolean(row.free_issue),
      lineSummary: text(row.line_summary),
    })),
    total: num(count?.total),
    page,
    pageSize,
  }
}

export type ApInvoiceRow = {
  docEntry: number
  docNo: string
  docDate: string
  dueDate: string | null
  cardCode: string
  cardName: string
  vendorRef: string | null
  total: number
  taxTotal: number
}

/** A/P (supplier) invoices newest first, cancelled ones and their mirrors left out. */
export async function apInvoices(sql: SapSql, filter: ProcurementFilter = {}): Promise<Paged<ApInvoiceRow>> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where not a.cancelled and not a.is_cancellation
    ${like ? sql`and (a.doc_no ilike ${like} or a.card_name ilike ${like} or a.vendor_ref ilike ${like})` : sql``}
    ${filter.from ? sql`and a.doc_date >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and a.doc_date <= ${filter.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select a.doc_entry, a.doc_no, a.doc_date, a.due_date, a.card_code, a.card_name, a.vendor_ref, a.total, a.tax_total
      from erp.ap_invoices a ${where}
      order by a.doc_date desc, a.doc_entry desc
      limit ${pageSize} offset ${offset}`,
    sql`select count(*) as total from erp.ap_invoices a ${where}`,
  ])
  return {
    rows: rows.map((row) => ({
      docEntry: num(row.doc_entry),
      docNo: String(row.doc_no),
      docDate: day(row.doc_date) ?? '',
      dueDate: day(row.due_date),
      cardCode: String(row.card_code ?? ''),
      cardName: String(row.card_name ?? ''),
      vendorRef: text(row.vendor_ref),
      total: num(row.total),
      taxTotal: num(row.tax_total),
    })),
    total: num(count?.total),
    page,
    pageSize,
  }
}

export type GrnLineHit = { itemCode: string; docNo: string; docDate: string; qty: number }

/** Live goods-receipt lines of these items dated on or after a day (the GRNs that absorb unposted receipts). */
export async function grnLinesSince(sql: SapSql, itemCodes: readonly string[], since: string): Promise<GrnLineHit[]> {
  if (itemCodes.length === 0) return []
  const rows = await sql`
    select l.item_code, g.doc_no, g.doc_date, l.qty
    from erp.grn_lines l join erp.grns g on g.doc_entry = l.doc_entry
    where l.item_code = any(${textArray(itemCodes)}::text[]) and g.doc_date >= ${since}::date
      and not g.cancelled and not g.is_cancellation
    order by g.doc_date, g.doc_entry, l.line_num`
  return rows.map((row) => ({ itemCode: String(row.item_code), docNo: String(row.doc_no), docDate: day(row.doc_date) ?? '', qty: num(row.qty) }))
}

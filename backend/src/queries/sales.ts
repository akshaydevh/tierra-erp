import {
  cardFilter,
  day,
  intArray,
  monthStart,
  num,
  numOrNull,
  pageRequest,
  searchPattern,
  text,
  textArray,
  timestamp,
  type CardScope,
  type Paged,
  type SapSql,
} from '../sap/db'

export const ORDER_STATES = ['all', 'open', 'closed', 'cancelled'] as const
export type OrderState = (typeof ORDER_STATES)[number]

export type SalesOrderRow = {
  docEntry: number
  docNo: string
  docDate: string
  dueDate: string | null
  cardCode: string
  cardName: string
  customerPoNo: string | null
  total: number
  status: 'open' | 'closed' | 'cancelled'
  stale: boolean
  lineCount: number
  totalQty: number
  invoiceCount: number
}

export type SalesOrderDetail = SalesOrderRow & {
  poDate: string | null
  shipToCode: string | null
  taxTotal: number
  approvalStatus: string | null
  createdBy: string | null
}

export type SalesOrderLine = {
  lineNum: number
  itemCode: string
  itemName: string
  qty: number
  openQty: number
  price: number
  lineTotal: number
  taxCode: string | null
  taxPct: number | null
  whsCode: string | null
  lineStatus: string | null
  invoiceDocEntry: number | null
}

export type InvoiceRow = {
  docEntry: number
  docNo: string
  docDate: string
  createdAt: string | null
  cardName: string
  customerPoNo: string | null
  total: number
  ewbNo: string | null
  ewbAt: string | null
  /** The e-way bill shown was cancelled on the portal (no live one exists for this invoice). */
  ewbCancelled: boolean
  irnStatus: string | null
  ackNo: string | null
  soDocEntries: number[]
}

export type ApprovalRow = {
  docObject: string
  docEntry: number | null
  draftEntry: number | null
  docNo: string | null
  status: 'approved' | 'rejected' | 'waiting'
  originator: string | null
  approver: string | null
  requestedAt: string | null
  decidedAt: string | null
  total: number | null
}

export type CustomerPoRow = {
  customerPoNo: string
  /** The customer's PAN, or its card code when it has no GSTIN; with customerPoNo it names one PO. */
  partyKey: string
  cardName: string
  cardCodes: string[]
  salesOrderCount: number
  firstDate: string
  lastDate: string
  total: number
  openCount: number
}

export type OrdersKpis = { open: number; stale: number; valueMtd: number; poCount: number }

export type OrdersFilter = {
  state?: OrderState
  q?: string | null
  /** Exact customer PO number and party key: the sales orders behind one row of the Customer POs tab. */
  po?: string | null
  party?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}

type Row = Record<string, unknown>

const SO_COLUMNS = `doc_entry, doc_no, doc_date, due_date, card_code, card_name, customer_po_no, total, status, stale,
  line_count, total_qty, invoice_count`

export function salesOrderRow(row: Row): SalesOrderRow {
  return {
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    docDate: day(row.doc_date) ?? '',
    dueDate: day(row.due_date),
    cardCode: String(row.card_code ?? ''),
    cardName: String(row.card_name ?? ''),
    customerPoNo: text(row.customer_po_no),
    total: num(row.total),
    status: row.status as SalesOrderRow['status'],
    stale: Boolean(row.stale),
    lineCount: num(row.line_count),
    totalQty: num(row.total_qty),
    invoiceCount: num(row.invoice_count),
  }
}

export function invoiceRow(row: Row): InvoiceRow {
  return {
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    docDate: day(row.doc_date) ?? '',
    createdAt: timestamp(row.created_at),
    cardName: String(row.card_name ?? ''),
    customerPoNo: text(row.customer_po_no),
    total: num(row.total),
    ewbNo: text(row.ewb_no),
    ewbAt: timestamp(row.ewb_at),
    ewbCancelled: row.ewb_cancelled === true,
    irnStatus: text(row.irn_status),
    ackNo: text(row.ack_no),
    soDocEntries: Array.isArray(row.so_doc_entries) ? row.so_doc_entries.map(num) : [],
  }
}

export const INVOICE_COLUMNS = `doc_entry, doc_no, doc_date, created_at, card_name, customer_po_no, total, ewb_no, ewb_at,
  ewb_cancelled, irn_status, ack_no, so_doc_entries`

function stateFilter(sql: SapSql, state: OrderState | undefined) {
  return state && state !== 'all' ? sql`and status = ${state}` : sql``
}

export async function orderKpis(sql: SapSql, asOf: string | null): Promise<OrdersKpis> {
  const from = asOf ? monthStart(asOf) : null
  const [row] = await sql`
    select count(*) filter (where status = 'open') as open,
           count(*) filter (where stale) as stale,
           coalesce(sum(total) filter (where status <> 'cancelled' and doc_date between ${from}::date and ${asOf}::date), 0)
             as value_mtd,
           count(distinct (customer_po_no, party_key)) filter (where customer_po_no is not null) as po_count
    from erp.sales_orders`
  return {
    open: num(row?.open),
    stale: num(row?.stale),
    valueMtd: num(row?.value_mtd),
    poCount: num(row?.po_count),
  }
}

/**
 * Every sales order, newest first. The search matches the number, customer and the customer's PO number;
 * po and party pick exactly the orders of one customer PO.
 */
export async function orderBook(sql: SapSql, filter: OrdersFilter = {}): Promise<Paged<SalesOrderRow>> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where true ${stateFilter(sql, filter.state)}
    ${
      like
        ? sql`and (doc_no ilike ${like} or card_name ilike ${like} or card_code ilike ${like}
                   or customer_po_no ilike ${like})`
        : sql``
    }
    ${filter.po ? sql`and customer_po_no = ${filter.po}` : sql``}
    ${filter.party ? sql`and party_key = ${filter.party}` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select ${sql.unsafe(SO_COLUMNS)} from erp.sales_orders ${where}
      order by doc_date desc, doc_entry desc
      limit ${pageSize} offset ${offset}`,
    sql`select count(*) as total from erp.sales_orders ${where}`,
  ])
  return { rows: rows.map(salesOrderRow), total: num(count?.total), page, pageSize }
}

/**
 * Sales orders grouped by the customer's PO number and who placed it (one PO is often called off over several
 * orders; two customers can use the same number). The state filter picks which sales orders count; cancelled
 * orders never add to the value.
 */
export async function customerPos(sql: SapSql, filter: OrdersFilter = {}): Promise<Paged<CustomerPoRow>> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where customer_po_no is not null ${stateFilter(sql, filter.state)}
    ${like ? sql`and (customer_po_no ilike ${like} or card_name ilike ${like} or card_code ilike ${like})` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select customer_po_no, party_key,
             string_agg(distinct card_name, ', ') as card_name,
             array_agg(distinct card_code order by card_code) as card_codes,
             count(*) as sales_order_count,
             min(doc_date) as first_date,
             max(doc_date) as last_date,
             coalesce(sum(total) filter (where status <> 'cancelled'), 0) as total,
             count(*) filter (where status = 'open') as open_count
      from erp.sales_orders ${where}
      group by customer_po_no, party_key
      order by max(doc_date) desc, customer_po_no, party_key
      limit ${pageSize} offset ${offset}`,
    sql`select count(distinct (customer_po_no, party_key)) as total from erp.sales_orders ${where}`,
  ])
  return {
    rows: rows.map((row) => ({
      customerPoNo: String(row.customer_po_no),
      partyKey: String(row.party_key),
      cardName: String(row.card_name ?? ''),
      cardCodes: Array.isArray(row.card_codes) ? row.card_codes.map(String) : [],
      salesOrderCount: num(row.sales_order_count),
      firstDate: day(row.first_date) ?? '',
      lastDate: day(row.last_date) ?? '',
      total: num(row.total),
      openCount: num(row.open_count),
    })),
    total: num(count?.total),
    page,
    pageSize,
  }
}

export async function recentSalesOrders(sql: SapSql, limit: number): Promise<SalesOrderRow[]> {
  const rows = await sql`
    select ${sql.unsafe(SO_COLUMNS)} from erp.sales_orders
    order by doc_date desc, doc_entry desc
    limit ${limit}`
  return rows.map(salesOrderRow)
}

export type SalesOrderView = {
  order: SalesOrderDetail
  lines: SalesOrderLine[]
  /** Summed in SQL over every line, so a cut list never changes them. */
  lineTotals: { lines: number; qty: number; openQty: number; value: number }
  invoices: InvoiceRow[]
  approvals: ApprovalRow[]
}

/** One sales order with its lines, the (live) invoices raised against it and its approval history. */
export async function salesOrder(sql: SapSql, docEntry: number): Promise<SalesOrderView | null> {
  const [head] = await sql`
    select ${sql.unsafe(SO_COLUMNS)}, po_date, ship_to_code, tax_total, approval_status, created_by
    from erp.sales_orders where doc_entry = ${docEntry}`
  if (!head) return null
  const [lines, [sums], invoices, approvals] = await Promise.all([
    sql`
      select line_num, item_code, item_name, qty, open_qty, price, line_total, tax_code, tax_pct, whs_code, line_status,
             invoice_doc_entry
      from erp.sales_order_lines where doc_entry = ${docEntry}
      order by sort_order, line_num`,
    sql`
      select count(*) as lines, coalesce(sum(qty), 0) as qty, coalesce(sum(open_qty), 0) as open_qty,
             coalesce(sum(line_total), 0) as value
      from erp.sales_order_lines where doc_entry = ${docEntry}`,
    sql`
      select ${sql.unsafe(INVOICE_COLUMNS)} from erp.invoices
      where ${docEntry} = any(so_doc_entries) and not cancelled and not is_cancellation
      order by doc_date, doc_entry`,
    sql`
      select doc_object, doc_entry, draft_entry, doc_no, status, originator, approver, requested_at, decided_at, total
      from erp.approvals_hist where doc_object = '17' and doc_entry = ${docEntry}
      order by requested_at, request_id`,
  ])
  return {
    order: {
      ...salesOrderRow(head),
      poDate: day(head.po_date),
      shipToCode: text(head.ship_to_code),
      taxTotal: num(head.tax_total),
      approvalStatus: text(head.approval_status),
      createdBy: text(head.created_by),
    },
    lines: lines.map((row) => ({
      lineNum: num(row.line_num),
      itemCode: String(row.item_code ?? ''),
      itemName: String(row.item_name ?? ''),
      qty: num(row.qty),
      openQty: num(row.open_qty),
      price: num(row.price),
      lineTotal: num(row.line_total),
      taxCode: text(row.tax_code),
      taxPct: numOrNull(row.tax_pct),
      whsCode: text(row.whs_code),
      lineStatus: text(row.line_status),
      invoiceDocEntry: numOrNull(row.invoice_doc_entry),
    })),
    lineTotals: { lines: num(sums?.lines), qty: num(sums?.qty), openQty: num(sums?.open_qty), value: num(sums?.value) },
    invoices: invoices.map(invoiceRow),
    approvals: approvals.map((row) => ({
      docObject: String(row.doc_object),
      docEntry: numOrNull(row.doc_entry),
      draftEntry: numOrNull(row.draft_entry),
      docNo: text(row.doc_no),
      status: row.status as ApprovalRow['status'],
      originator: text(row.originator),
      approver: text(row.approver),
      requestedAt: timestamp(row.requested_at),
      decidedAt: timestamp(row.decided_at),
      total: numOrNull(row.total),
    })),
  }
}

export type SalesSummary = {
  openSalesOrders: number
  staleOpenSalesOrders: number
  salesMtdValue: number
  salesMtdCount: number
  invoicesLastDay: number
}

/**
 * Command-centre sales figures. Sales this month are invoices (not cancelled, not cancellation mirrors)
 * dated from the 1st of the data month to the data date; the last day is the data date itself.
 */
export async function salesSummary(sql: SapSql, asOf: string | null): Promise<SalesSummary> {
  const from = asOf ? monthStart(asOf) : null
  const [[orders], [invoices]] = await Promise.all([
    sql`
      select count(*) filter (where status = 'open') as open, count(*) filter (where stale) as stale
      from erp.sales_orders`,
    sql`
      select coalesce(sum(total) filter (where doc_date between ${from}::date and ${asOf}::date), 0) as mtd_value,
             count(*) filter (where doc_date between ${from}::date and ${asOf}::date) as mtd_count,
             count(*) filter (where doc_date = ${asOf}::date) as last_day
      from erp.invoices
      where not cancelled and not is_cancellation`,
  ])
  return {
    openSalesOrders: num(orders?.open),
    staleOpenSalesOrders: num(orders?.stale),
    salesMtdValue: num(invoices?.mtd_value),
    salesMtdCount: num(invoices?.mtd_count),
    invoicesLastDay: num(invoices?.last_day),
  }
}

// ---- Agent reads. Each takes the caller's CardScope: a customer group only ever sees its own cards. ----------------

/** How many rows an agent list returns; the total says how many matched. */
export const AGENT_LIST_LIMIT = 10

export type AgentList<T> = { rows: T[]; total: number }

export type SalesOrderSearch = {
  q?: string | null
  state?: OrderState
  customerPoNo?: string | null
  itemCode?: string | null
  from?: string | null
  to?: string | null
  limit?: number
}

/** Sales orders newest first, within the caller's cards; value sums every match (cancelled ones left out). */
export async function findSalesOrders(
  sql: SapSql,
  cards: CardScope,
  search: SalesOrderSearch = {},
): Promise<AgentList<SalesOrderRow> & { value: number }> {
  const like = searchPattern(search.q)
  const where = sql`
    where true ${cardFilter(sql, cards)} ${stateFilter(sql, search.state)}
    ${
      like
        ? sql`and (doc_no ilike ${like} or card_name ilike ${like} or card_code ilike ${like}
                   or customer_po_no ilike ${like})`
        : sql``
    }
    ${search.customerPoNo ? sql`and customer_po_no = ${search.customerPoNo}` : sql``}
    ${
      search.itemCode
        ? sql`and exists (select 1 from erp.sales_order_lines l
                          where l.doc_entry = erp.sales_orders.doc_entry and l.item_code = ${search.itemCode})`
        : sql``
    }
    ${search.from ? sql`and doc_date >= ${search.from}::date` : sql``}
    ${search.to ? sql`and doc_date <= ${search.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select ${sql.unsafe(SO_COLUMNS)} from erp.sales_orders ${where}
      order by doc_date desc, doc_entry desc
      limit ${search.limit ?? AGENT_LIST_LIMIT}`,
    sql`select count(*) as total, coalesce(sum(total) filter (where status <> 'cancelled'), 0) as value
        from erp.sales_orders ${where}`,
  ])
  return { rows: rows.map(salesOrderRow), total: num(count?.total), value: num(count?.value) }
}

/** One sales order by its number (SO/26-27/445), only when it is one of the caller's cards. */
export async function salesOrderByNo(sql: SapSql, cards: CardScope, docNo: string): Promise<SalesOrderView | null> {
  const [row] = await sql`
    select doc_entry from erp.sales_orders where doc_no = ${docNo} ${cardFilter(sql, cards)}
    order by doc_entry desc limit 1`
  return row ? salesOrder(sql, num(row.doc_entry)) : null
}

export type InvoiceListRow = InvoiceRow & { cardCode: string; soDocNos: string[] }

const LIVE_INVOICE = 'not i.cancelled and not i.is_cancellation'

function invoiceListRow(row: Row): InvoiceListRow {
  return {
    ...invoiceRow(row),
    cardCode: String(row.card_code ?? ''),
    soDocNos: Array.isArray(row.so_doc_nos) ? row.so_doc_nos.map(String) : [],
  }
}

const INVOICE_LIST_COLUMNS = `i.doc_entry, i.doc_no, i.doc_date, i.created_at, i.card_code, i.card_name, i.customer_po_no,
  i.total, i.ewb_no, i.ewb_at, i.ewb_cancelled, i.irn_status, i.ack_no, i.so_doc_entries,
  (select coalesce(array_agg(o.doc_no order by o.doc_entry), '{}') from erp.sales_orders o
    where o.doc_entry = any(i.so_doc_entries)) as so_doc_nos`

export type CustomerPoStatus = {
  customerPoNo: string
  salesOrders: Array<{
    docNo: string
    docDate: string
    cardCode: string
    cardName: string
    status: SalesOrderRow['status']
    total: number
    orderedQty: number
    openQty: number
  }>
  invoices: InvoiceListRow[]
  /** Summed in SQL over everything found, so a cut list never changes them. */
  totals: {
    salesOrders: number
    /** Sales order value, cancelled orders left out. */
    value: number
    orderedQty: number
    openQty: number
    invoices: number
    invoiceValue: number
  }
}

/**
 * Everything raised against one customer PO number within the caller's cards: its sales orders (ordered and still
 * open quantity) and the live invoices against those orders or quoting the PO number, with their totals.
 */
export async function customerPoStatus(sql: SapSql, cards: CardScope, customerPoNo: string): Promise<CustomerPoStatus> {
  const orders = await sql`
    select o.doc_entry, o.doc_no, o.doc_date, o.card_code, o.card_name, o.status, o.total,
           coalesce(sum(l.qty), 0) as ordered_qty, coalesce(sum(l.open_qty), 0) as open_qty
    from erp.sales_orders o
    left join erp.sales_order_lines l on l.doc_entry = o.doc_entry
    where o.customer_po_no = ${customerPoNo} ${cardFilter(sql, cards, 'o.card_code')}
    group by o.doc_entry, o.doc_no, o.doc_date, o.card_code, o.card_name, o.status, o.total
    order by o.doc_date, o.doc_entry`
  const entries = orders.map((row) => num(row.doc_entry))
  const invoiceWhere = sql`
    where ${sql.unsafe(LIVE_INVOICE)} ${cardFilter(sql, cards, 'i.card_code')}
      and (i.customer_po_no = ${customerPoNo} or i.so_doc_entries && ${intArray(entries)}::integer[])`
  const [invoices, [orderSums], [invoiceSums]] = await Promise.all([
    sql`
      select ${sql.unsafe(INVOICE_LIST_COLUMNS)} from erp.invoices i ${invoiceWhere}
      order by i.doc_date, i.doc_entry`,
    sql`
      select count(*) as orders,
             coalesce(sum(o.total) filter (where o.status <> 'cancelled'), 0) as value,
             coalesce((select sum(l.qty) from erp.sales_order_lines l where l.doc_entry = any(${intArray(entries)}::integer[])), 0) as ordered,
             coalesce((select sum(l.open_qty) from erp.sales_order_lines l where l.doc_entry = any(${intArray(entries)}::integer[])), 0) as open
      from erp.sales_orders o
      where o.customer_po_no = ${customerPoNo} ${cardFilter(sql, cards, 'o.card_code')}`,
    sql`select count(*) as invoices, coalesce(sum(i.total), 0) as value from erp.invoices i ${invoiceWhere}`,
  ])
  return {
    totals: {
      salesOrders: num(orderSums?.orders),
      value: num(orderSums?.value),
      orderedQty: num(orderSums?.ordered),
      openQty: num(orderSums?.open),
      invoices: num(invoiceSums?.invoices),
      invoiceValue: num(invoiceSums?.value),
    },
    customerPoNo,
    salesOrders: orders.map((row) => ({
      docNo: String(row.doc_no),
      docDate: day(row.doc_date) ?? '',
      cardCode: String(row.card_code ?? ''),
      cardName: String(row.card_name ?? ''),
      status: row.status as SalesOrderRow['status'],
      total: num(row.total),
      orderedQty: num(row.ordered_qty),
      openQty: num(row.open_qty),
    })),
    invoices: invoices.map(invoiceListRow),
  }
}

export type InvoiceSearch = {
  q?: string | null
  customerPoNo?: string | null
  itemCode?: string | null
  from?: string | null
  to?: string | null
  limit?: number
}

/** Live invoices (not cancelled, no cancellation mirrors) newest first, within the caller's cards. */
export async function findInvoices(
  sql: SapSql,
  cards: CardScope,
  search: InvoiceSearch = {},
): Promise<AgentList<InvoiceListRow> & { value: number }> {
  const like = searchPattern(search.q)
  const where = sql`
    where ${sql.unsafe(LIVE_INVOICE)} ${cardFilter(sql, cards, 'i.card_code')}
    ${
      like
        ? sql`and (i.doc_no ilike ${like} or i.card_name ilike ${like} or i.card_code ilike ${like}
                   or i.customer_po_no ilike ${like})`
        : sql``
    }
    ${search.customerPoNo ? sql`and i.customer_po_no = ${search.customerPoNo}` : sql``}
    ${
      search.itemCode
        ? sql`and exists (select 1 from erp.invoice_lines l where l.doc_entry = i.doc_entry and l.item_code = ${search.itemCode})`
        : sql``
    }
    ${search.from ? sql`and i.doc_date >= ${search.from}::date` : sql``}
    ${search.to ? sql`and i.doc_date <= ${search.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select ${sql.unsafe(INVOICE_LIST_COLUMNS)} from erp.invoices i ${where}
      order by i.doc_date desc, i.doc_entry desc
      limit ${search.limit ?? AGENT_LIST_LIMIT}`,
    sql`select count(*) as total, coalesce(sum(i.total), 0) as value from erp.invoices i ${where}`,
  ])
  return { rows: rows.map(invoiceListRow), total: num(count?.total), value: num(count?.value) }
}

export type InvoiceLine = {
  lineNum: number
  itemCode: string
  itemName: string
  qty: number
  uom: string | null
  price: number
  lineTotal: number
  taxPct: number | null
}

export type InvoiceView = {
  invoice: InvoiceListRow & { taxTotal: number; cancelled: boolean; isCancellation: boolean; ewbValidTill: string | null }
  lines: InvoiceLine[]
}

/** One A/R invoice by number (TF/26-27/447) with its lines, only when it is one of the caller's cards. */
export async function invoiceByNo(sql: SapSql, cards: CardScope, docNo: string): Promise<InvoiceView | null> {
  const [head] = await sql`
    select ${sql.unsafe(INVOICE_LIST_COLUMNS)}, i.tax_total, i.cancelled, i.is_cancellation, i.ewb_valid_till
    from erp.invoices i
    where i.doc_no = ${docNo} ${cardFilter(sql, cards, 'i.card_code')}
    order by i.is_cancellation, i.doc_entry desc
    limit 1`
  if (!head) return null
  const lines = await sql`
    select line_num, item_code, item_name, qty, uom, price, line_total, tax_pct
    from erp.invoice_lines where doc_entry = ${num(head.doc_entry)}
    order by line_num`
  return {
    invoice: {
      ...invoiceListRow(head),
      taxTotal: num(head.tax_total),
      cancelled: Boolean(head.cancelled),
      isCancellation: Boolean(head.is_cancellation),
      ewbValidTill: day(head.ewb_valid_till),
    },
    lines: lines.map((row) => ({
      lineNum: num(row.line_num),
      itemCode: String(row.item_code ?? ''),
      itemName: String(row.item_name ?? ''),
      qty: num(row.qty),
      uom: text(row.uom),
      price: num(row.price),
      lineTotal: num(row.line_total),
      taxPct: numOrNull(row.tax_pct),
    })),
  }
}

export type CreditNoteRow = {
  docEntry: number
  docNo: string
  docDate: string
  cardCode: string
  cardName: string
  total: number
  customerRef: string | null
  baseInvoiceDocNos: string[]
  irnStatus: string | null
}

/** Live credit notes newest first, within the caller's cards. */
export async function findCreditNotes(
  sql: SapSql,
  cards: CardScope,
  search: { q?: string | null; from?: string | null; to?: string | null; limit?: number } = {},
): Promise<AgentList<CreditNoteRow> & { value: number }> {
  const like = searchPattern(search.q)
  const where = sql`
    where not c.cancelled and not c.is_cancellation ${cardFilter(sql, cards, 'c.card_code')}
    ${like ? sql`and (c.doc_no ilike ${like} or c.card_name ilike ${like} or c.customer_ref ilike ${like})` : sql``}
    ${search.from ? sql`and c.doc_date >= ${search.from}::date` : sql``}
    ${search.to ? sql`and c.doc_date <= ${search.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select c.doc_entry, c.doc_no, c.doc_date, c.card_code, c.card_name, c.total, c.customer_ref, c.irn_status,
             (select coalesce(array_agg(i.doc_no order by i.doc_entry), '{}') from erp.invoices i
               where i.doc_entry = any(c.base_invoice_doc_entries)) as base_doc_nos
      from erp.credit_notes c ${where}
      order by c.doc_date desc, c.doc_entry desc
      limit ${search.limit ?? AGENT_LIST_LIMIT}`,
    sql`select count(*) as total, coalesce(sum(c.total), 0) as value from erp.credit_notes c ${where}`,
  ])
  return {
    rows: rows.map((row) => ({
      docEntry: num(row.doc_entry),
      docNo: String(row.doc_no),
      docDate: day(row.doc_date) ?? '',
      cardCode: String(row.card_code ?? ''),
      cardName: String(row.card_name ?? ''),
      total: num(row.total),
      customerRef: text(row.customer_ref),
      baseInvoiceDocNos: Array.isArray(row.base_doc_nos) ? row.base_doc_nos.map(String) : [],
      irnStatus: text(row.irn_status),
    })),
    total: num(count?.total),
    value: num(count?.value),
  }
}

/** Customer PO numbers that exist within the caller's cards, with who placed them and their sales orders. */
export async function knownCustomerPos(
  sql: SapSql,
  cards: CardScope,
  poNos: readonly string[],
): Promise<Array<{ customerPoNo: string; cardName: string; soDocNos: string[] }>> {
  if (poNos.length === 0) return []
  const rows = await sql`
    select customer_po_no, string_agg(distinct card_name, ', ') as card_name,
           array_agg(doc_no order by doc_entry) as doc_nos
    from erp.sales_orders
    where customer_po_no = any(${textArray(poNos)}::text[]) ${cardFilter(sql, cards)}
    group by customer_po_no`
  return rows.map((row) => ({
    customerPoNo: String(row.customer_po_no),
    cardName: String(row.card_name ?? ''),
    soDocNos: Array.isArray(row.doc_nos) ? row.doc_nos.map(String) : [],
  }))
}

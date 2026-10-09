import {
  day,
  monthStart,
  num,
  numOrNull,
  pageRequest,
  searchPattern,
  text,
  type Paged,
  type SapSql,
} from '../sap/db'

export const PRODUCTION_STATUSES = ['planned', 'released', 'closed', 'cancelled'] as const
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number]

export type ProductionRow = {
  docEntry: number
  docNo: string
  docNum: number
  itemCode: string
  itemName: string
  type: 'standard' | 'disassembly'
  status: ProductionStatus
  plannedQty: number
  completedQty: number
  postDate: string | null
  startDate: string | null
  dueDate: string | null
  closeDate: string | null
  cardCode: string | null
  customerName: string | null
  stockType: string | null
  issuedValue: number | null
  receivedValue: number | null
  comments: string | null
}

export type ProductionComponent = {
  lineNum: number
  itemCode: string
  itemName: string
  materialRole: string | null
  plannedQty: number
  issuedQty: number
  uom: string | null
  issueMethod: string | null
  issuedValue: number | null
}

export type ProductionKpis = {
  openOrders: number
  completedMtdQty: number
  ordersMtd: number
  disassemblyMtd: number
}

export type ProductionFilter = {
  status?: ProductionStatus | null
  q?: string | null
  /** Posting-date range, inclusive. */
  from?: string | null
  to?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}

const COLUMNS = `doc_entry, doc_no, doc_num, item_code, item_name, type, status, planned_qty, completed_qty, post_date,
  start_date, due_date, close_date, card_code, customer_name, stock_type, issued_value, received_value, comments`

function productionRow(row: Record<string, unknown>): ProductionRow {
  return {
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    docNum: num(row.doc_num),
    itemCode: String(row.item_code ?? ''),
    itemName: String(row.item_name ?? ''),
    type: row.type as ProductionRow['type'],
    status: row.status as ProductionStatus,
    plannedQty: num(row.planned_qty),
    completedQty: num(row.completed_qty),
    postDate: day(row.post_date),
    startDate: day(row.start_date),
    dueDate: day(row.due_date),
    closeDate: day(row.close_date),
    cardCode: text(row.card_code),
    customerName: text(row.customer_name),
    stockType: text(row.stock_type),
    issuedValue: numOrNull(row.issued_value),
    receivedValue: numOrNull(row.received_value),
    comments: text(row.comments),
  }
}

/**
 * Month-to-date figures over production orders posted from the 1st of the data month (cancelled ones left out).
 * Completed quantity counts standard orders only: a disassembly receives materials back, not finished goods.
 */
export async function productionKpis(sql: SapSql, asOf: string | null): Promise<ProductionKpis> {
  const from = asOf ? monthStart(asOf) : null
  const [row] = await sql`
    select count(*) filter (where status in ('planned', 'released')) as open_orders,
           coalesce(sum(completed_qty) filter (where mtd and type = 'standard'), 0) as completed_mtd_qty,
           count(*) filter (where mtd) as orders_mtd,
           count(*) filter (where mtd and type = 'disassembly') as disassembly_mtd
    from (
      select *, status <> 'cancelled' and post_date between ${from}::date and ${asOf}::date as mtd
      from erp.production_orders
    ) p`
  return {
    openOrders: num(row?.open_orders),
    completedMtdQty: num(row?.completed_mtd_qty),
    ordersMtd: num(row?.orders_mtd),
    disassemblyMtd: num(row?.disassembly_mtd),
  }
}

/** Production orders, newest first; every status unless one is asked for. */
export async function productionOrders(sql: SapSql, filter: ProductionFilter = {}): Promise<Paged<ProductionRow>> {
  const like = searchPattern(filter.q)
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const where = sql`
    where true
    ${filter.status ? sql`and status = ${filter.status}` : sql``}
    ${
      like
        ? sql`and (doc_no ilike ${like} or item_code ilike ${like} or item_name ilike ${like}
                   or customer_name ilike ${like} or card_code ilike ${like})`
        : sql``
    }
    ${filter.from ? sql`and post_date >= ${filter.from}::date` : sql``}
    ${filter.to ? sql`and post_date <= ${filter.to}::date` : sql``}`
  const [rows, [count]] = await Promise.all([
    sql`
      select ${sql.unsafe(COLUMNS)} from erp.production_orders ${where}
      order by post_date desc nulls last, doc_entry desc
      limit ${pageSize} offset ${offset}`,
    sql`select count(*) as total from erp.production_orders ${where}`,
  ])
  return { rows: rows.map(productionRow), total: num(count?.total), page, pageSize }
}

/**
 * A production order without its ₹ values (material issued, goods received, per component): costing is for the
 * manager and the admin; the office keeps the quantities.
 */
export function withoutOrderValues<T extends { issuedValue: number | null; receivedValue: number | null }>(order: T): T {
  return { ...order, issuedValue: null, receivedValue: null }
}

export function withoutComponentValues<T extends { issuedValue: number | null }>(line: T): T {
  return { ...line, issuedValue: null }
}

export async function productionOrder(
  sql: SapSql,
  docEntry: number,
): Promise<{ order: ProductionRow; components: ProductionComponent[] } | null> {
  const [head] = await sql`select ${sql.unsafe(COLUMNS)} from erp.production_orders where doc_entry = ${docEntry}`
  if (!head) return null
  const components = await sql`
    select line_num, item_code, item_name, material_role, planned_qty, issued_qty, uom, issue_method, issued_value
    from erp.production_components where doc_entry = ${docEntry}
    order by sort_order, line_num`
  return {
    order: productionRow(head),
    components: components.map((row) => ({
      lineNum: num(row.line_num),
      itemCode: String(row.item_code ?? ''),
      itemName: String(row.item_name ?? ''),
      materialRole: text(row.material_role),
      plannedQty: num(row.planned_qty),
      issuedQty: num(row.issued_qty),
      uom: text(row.uom),
      issueMethod: text(row.issue_method),
      issuedValue: numOrNull(row.issued_value),
    })),
  }
}

export type ConsumptionLine = {
  itemCode: string
  itemName: string
  materialRole: string | null
  uom: string | null
  plannedQty: number
  issuedQty: number
  issuedValue: number | null
  /** BOM quantity per piece x the completed quantity; null when the item is not on the current BOM. */
  bomQty: number | null
  /** The BOM line is a placeholder (a dummy banana or flavour quantity), so bomQty is not a real standard. */
  bomPlaceholder: boolean
  /** issued - bomQty. */
  varianceQty: number | null
  variancePct: number | null
}

export type ConsumptionView = { order: ProductionRow; lines: ConsumptionLine[] }

/**
 * What a production order (PR/26-27/101) consumed against its bill of materials: the issued quantity per
 * component (goods issues posted against the order) next to the BOM standard for the completed quantity. BOM lines
 * the order never used are listed too, with nothing issued.
 */
export async function consumptionVsBom(sql: SapSql, docNo: string): Promise<ConsumptionView | null> {
  const [head] = await sql`
    select ${sql.unsafe(COLUMNS)} from erp.production_orders where doc_no = ${docNo} order by doc_entry desc limit 1`
  if (!head) return null
  const order = productionRow(head)
  const rows = await sql`
    with used as (
      select item_code, max(item_name) as item_name, max(material_role) as material_role, max(uom) as uom,
             sum(planned_qty) as planned_qty, sum(issued_qty) as issued_qty, sum(issued_value) as issued_value,
             min(sort_order) as sort_order
      from erp.production_components where doc_entry = ${order.docEntry}
      group by item_code
    ), bom as (
      select component_code as item_code, max(component_name) as item_name, max(material_role) as material_role,
             max(uom) as uom, sum(qty_per_unit) as qty_per_unit, bool_or(is_placeholder) as placeholder
      from erp.bom_lines where fg_item_code = ${order.itemCode}
      group by component_code
    )
    select coalesce(u.item_code, b.item_code) as item_code, coalesce(u.item_name, b.item_name) as item_name,
           coalesce(u.material_role, b.material_role) as material_role, coalesce(u.uom, b.uom) as uom,
           coalesce(u.planned_qty, 0) as planned_qty, coalesce(u.issued_qty, 0) as issued_qty, u.issued_value,
           b.qty_per_unit, coalesce(b.placeholder, false) as placeholder
    from used u full join bom b on b.item_code = u.item_code
    order by u.sort_order nulls last, 1`
  return {
    order,
    lines: rows.map((row) => {
      const issued = num(row.issued_qty)
      const bomQty = row.qty_per_unit == null ? null : round(num(row.qty_per_unit) * order.completedQty, 4)
      const variance = bomQty == null ? null : round(issued - bomQty, 4)
      return {
        itemCode: String(row.item_code),
        itemName: String(row.item_name ?? ''),
        materialRole: text(row.material_role),
        uom: text(row.uom),
        plannedQty: num(row.planned_qty),
        issuedQty: issued,
        issuedValue: numOrNull(row.issued_value),
        bomQty,
        bomPlaceholder: Boolean(row.placeholder),
        varianceQty: variance,
        variancePct: bomQty && variance != null ? round((variance / bomQty) * 100, 1) : null,
      }
    }),
  }
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

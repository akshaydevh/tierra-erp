import { day, num, numOrNull, pageRequest, searchPattern, text, textArray, type Paged, type SapSql } from '../sap/db'
import { round2 } from './finance'

/**
 * Costing reads over the erp costing views (sql/erp/13_costing.sql). SAP holds material cost only: production orders
 * have no labour or overhead lines, and the labour / power / water items are issued at ₹0. So every cost here is
 * material cost, and the pages and the agent say so; labour and overheads are never estimated.
 *
 * Material cost of a sold piece: what SAP valued the SKU's production receipts at in the same months (issued material
 * per piece); for a SKU not produced in those months, SAP's cost of goods sold at invoice (INV1.StockPrice).
 */

export const NO_LABOUR =
  'Material cost only: SAP has no labour or overhead cost (power, water and labour are issued to production at ₹0).'

/** First day of a month, from YYYY-MM or YYYY-MM-DD; null for anything else. */
export function monthOf(value: string | null | undefined): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])(?:-\d{2})?$/.exec(value?.trim() ?? '')
  return match ? `${match[1]}-${match[2]}-01` : null
}

export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, '0')}-01`
}

/** Months with production or sales, newest first. */
export async function costingMonths(sql: SapSql): Promise<string[]> {
  const rows = await sql`
    select month from erp.fg_cost_monthly union select month from erp.sku_margin_monthly order by month desc limit 36`
  return rows.map((row) => day(row.month)!)
}

export type CostingKpis = {
  month: string
  producedKg: number
  producedPcs: number
  productionValue: number
  /** Material cost per kg produced (the receipts' value). */
  materialCostPerKg: number | null
  soldKg: number
  revenue: number
  materialCost: number
  materialMargin: number
  marginPerKg: number | null
  marginPct: number | null
}

async function kpisFor(sql: SapSql, month: string): Promise<CostingKpis> {
  const [[made], [sold]] = await Promise.all([
    sql`
      select coalesce(sum(produced_kg), 0) as kg, coalesce(sum(produced_qty), 0) as pcs, coalesce(sum(produced_value), 0) as value
      from erp.fg_cost_monthly where month = ${month}::date`,
    sql`
      with c as (
        select item_code, sum(produced_value) / nullif(sum(produced_qty), 0) as cost
        from erp.fg_cost_monthly where month = ${month}::date group by item_code
      )
      select coalesce(sum(s.kg), 0) as kg, coalesce(sum(s.revenue), 0) as revenue,
             coalesce(sum(coalesce(s.qty * c.cost, s.cogs)), 0) as cost
      from erp.sku_margin_monthly s left join c using (item_code) where s.month = ${month}::date`,
  ])
  const producedKg = num(made?.kg)
  const productionValue = num(made?.value)
  const soldKg = num(sold?.kg)
  const revenue = num(sold?.revenue)
  const materialCost = num(sold?.cost)
  const margin = revenue - materialCost
  return {
    month,
    producedKg: round2(producedKg),
    producedPcs: num(made?.pcs),
    productionValue: round2(productionValue),
    materialCostPerKg: producedKg ? round2(productionValue / producedKg) : null,
    soldKg: round2(soldKg),
    revenue: round2(revenue),
    materialCost: round2(materialCost),
    materialMargin: round2(margin),
    marginPerKg: soldKg ? round2(margin / soldKg) : null,
    marginPct: revenue ? round2((margin / revenue) * 100) : null,
  }
}

/** The month's KPIs and the month before, for the change. */
export async function costingKpis(sql: SapSql, month: string): Promise<{ current: CostingKpis; previous: CostingKpis }> {
  const [current, previous] = await Promise.all([kpisFor(sql, month), kpisFor(sql, previousMonth(month))])
  return { current, previous }
}

export type MarginRow = {
  key: string
  itemCode: string | null
  name: string
  cards: number
  qty: number
  kg: number
  revenue: number
  /** Material cost of what was sold (production cost per piece of the period, else SAP COGS). */
  materialCost: number
  /** SAP's cost of goods sold at invoice (INV1.StockPrice x qty). */
  cogs: number
  margin: number
  pricePerPc: number | null
  costPerPc: number | null
  cogsPerPc: number | null
  marginPerPc: number | null
  marginPerKg: number | null
  marginPct: number | null
  /** Share of the quantity whose cost came from SAP COGS (the SKU was not produced in the period). */
  cogsFallbackPct: number
}

export type MarginFilter = {
  from: string
  to: string
  by: 'sku' | 'customer'
  itemCodes?: readonly string[] | null
  cardCodes?: readonly string[] | null
  q?: string | null
  limit?: number
}

export type MarginTotals = Omit<MarginRow, 'key' | 'itemCode' | 'name' | 'cards'>

function marginRow(row: Record<string, unknown>, by: 'sku' | 'customer'): MarginRow {
  const qty = num(row.qty)
  const kg = num(row.kg)
  const revenue = num(row.revenue)
  const materialCost = num(row.material_cost)
  const cogs = num(row.cogs)
  const margin = revenue - materialCost
  const perPc = (value: number) => (by === 'sku' && qty ? round2(value / qty) : null)
  return {
    key: String(row.key),
    itemCode: by === 'sku' ? String(row.key) : null,
    name: text(row.name) ?? String(row.key),
    cards: num(row.cards),
    qty,
    kg: round2(kg),
    revenue: round2(revenue),
    materialCost: round2(materialCost),
    cogs: round2(cogs),
    margin: round2(margin),
    pricePerPc: perPc(revenue),
    costPerPc: perPc(materialCost),
    cogsPerPc: perPc(cogs),
    marginPerPc: perPc(margin),
    marginPerKg: kg ? round2(margin / kg) : null,
    marginPct: revenue ? round2((margin / revenue) * 100) : null,
    cogsFallbackPct: qty ? round2((num(row.fallback_qty) / qty) * 100) : 0,
  }
}

/**
 * Material margin per SKU or per customer (company: branch cards with one PAN together) over whole months, largest
 * revenue first, with the totals of everything that matched.
 */
export async function skuMargins(sql: SapSql, filter: MarginFilter): Promise<{ rows: MarginRow[]; totals: MarginTotals; count: number }> {
  const items = filter.itemCodes?.length ? textArray(filter.itemCodes) : null
  const cards = filter.cardCodes ? textArray(filter.cardCodes) : null
  const like = searchPattern(filter.q)
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const key = filter.by === 'sku' ? sql`s.item_code` : sql`s.group_key`
  const name = filter.by === 'sku' ? sql`min(s.item_name)` : sql`min(s.card_name)`
  const rows = await sql`
    with c as (
      select item_code, sum(produced_value) / nullif(sum(produced_qty), 0) as cost
      from erp.fg_cost_monthly where month between ${filter.from}::date and ${filter.to}::date group by item_code
    ),
    s as (
      select s.*, c.cost from erp.sku_margin_monthly s left join c using (item_code)
      where s.month between ${filter.from}::date and ${filter.to}::date
        and (${items}::text[] is null or s.item_code = any(${items}::text[]))
        and (${cards}::text[] is null or s.card_code = any(${cards}::text[]))
        and (${like}::text is null or s.item_code ilike ${like} or s.item_name ilike ${like} or s.card_name ilike ${like})
    ),
    g as (
      select ${key} as key, ${name} as name, count(distinct s.card_code) as cards,
             sum(s.qty) as qty, sum(s.kg) as kg, sum(s.revenue) as revenue, sum(s.cogs) as cogs,
             sum(coalesce(s.qty * s.cost, s.cogs)) as material_cost,
             coalesce(sum(s.qty) filter (where s.cost is null), 0) as fallback_qty
      from s group by 1
    )
    select g.*, count(*) over () as total_count,
           sum(qty) over () as t_qty, sum(kg) over () as t_kg, sum(revenue) over () as t_revenue,
           sum(cogs) over () as t_cogs, sum(material_cost) over () as t_material_cost, sum(fallback_qty) over () as t_fallback_qty
    from g order by revenue desc nulls last limit ${limit}`
  const first = rows[0]
  const totals = marginRow(
    {
      key: 'total',
      name: 'Total',
      qty: first?.t_qty,
      kg: first?.t_kg,
      revenue: first?.t_revenue,
      cogs: first?.t_cogs,
      material_cost: first?.t_material_cost,
      fallback_qty: first?.t_fallback_qty,
    },
    filter.by,
  )
  const { key: _k, itemCode: _i, name: _n, cards: _c, ...rest } = totals
  return { rows: rows.map((row) => marginRow(row, filter.by)), totals: rest, count: num(first?.total_count) }
}

export type ProductionCostRow = {
  docEntry: number
  docNo: string
  itemCode: string
  itemName: string | null
  type: string
  status: string
  postDate: string | null
  closeDate: string | null
  lastReceipt: string | null
  cardCode: string | null
  customerName: string | null
  completedQty: number
  producedQty: number
  producedKg: number | null
  packGrams: number | null
  issuedValue: number
  returnedValue: number
  materialCost: number
  producedValue: number
  costPerPc: number | null
  costPerKg: number | null
  breakdown: Array<{ role: string; value: number }>
  overheadQty: number
}

const BREAKDOWN: Array<[string, string]> = [
  ['raw_banana', 'banana_value'],
  ['raw_cassava', 'cassava_value'],
  ['oil', 'oil_value'],
  ['laminate', 'laminate_value'],
  ['carton', 'carton_value'],
  ['seasoning', 'seasoning_value'],
  ['consumable', 'consumable_value'],
  ['fg_reused', 'fg_reused_value'],
  ['other', 'other_value'],
]

function costRow(row: Record<string, unknown>): ProductionCostRow {
  return {
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    itemCode: String(row.item_code),
    itemName: text(row.item_name),
    type: String(row.type),
    status: String(row.status),
    postDate: day(row.post_date),
    closeDate: day(row.close_date),
    lastReceipt: day(row.last_receipt),
    cardCode: text(row.card_code),
    customerName: text(row.customer_name),
    completedQty: num(row.completed_qty),
    producedQty: num(row.produced_qty),
    producedKg: numOrNull(row.produced_kg),
    packGrams: numOrNull(row.pack_grams),
    issuedValue: round2(num(row.issued_value)),
    returnedValue: round2(num(row.returned_value)),
    materialCost: round2(num(row.material_cost)),
    producedValue: round2(num(row.produced_value)),
    costPerPc: row.cost_per_pc == null ? null : round2(num(row.cost_per_pc)),
    costPerKg: numOrNull(row.cost_per_kg),
    breakdown: BREAKDOWN.map(([role, column]) => ({ role, value: round2(num(row[column])) })).filter((part) => part.value !== 0),
    overheadQty: num(row.overhead_qty),
  }
}

/** One production order's material cost; by doc number (PR/26-27/101) or doc entry. */
export async function productionCost(sql: SapSql, key: { docNo?: string; docEntry?: number }): Promise<ProductionCostRow | null> {
  const rows = key.docEntry
    ? await sql`select * from erp.production_costs where doc_entry = ${key.docEntry}`
    : await sql`select * from erp.production_costs where upper(doc_no) = upper(${key.docNo ?? ''})`
  return rows[0] ? costRow(rows[0]) : null
}

export type ProductionCostFilter = {
  itemCodes?: readonly string[] | null
  cardCodes?: readonly string[] | null
  q?: string | null
  from?: string | null
  to?: string | null
  page?: string | number | null
  pageSize?: number
}

/**
 * Finished-goods production orders with output in the period (by their last receipt), newest first, with the totals
 * over all that matched: pieces, kg, material cost and the weighted cost per piece / kg.
 */
export async function productionCosts(
  sql: SapSql,
  filter: ProductionCostFilter = {},
): Promise<Paged<ProductionCostRow> & { totals: { orders: number; producedQty: number; producedKg: number; materialCost: number; costPerKg: number | null } }> {
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const items = filter.itemCodes?.length ? textArray(filter.itemCodes) : null
  const cards = filter.cardCodes ? textArray(filter.cardCodes) : null
  const like = searchPattern(filter.q)
  const where = sql`
    where p.material_role = 'fg' and p.type = 'standard' and p.status <> 'cancelled' and p.produced_qty > 0
      and (${filter.from ?? null}::date is null or p.last_receipt >= ${filter.from ?? null}::date)
      and (${filter.to ?? null}::date is null or p.last_receipt <= ${filter.to ?? null}::date)
      and (${items}::text[] is null or p.item_code = any(${items}::text[]))
      and (${cards}::text[] is null or p.card_code = any(${cards}::text[]))
      and (${like}::text is null or p.doc_no ilike ${like} or p.item_code ilike ${like} or p.item_name ilike ${like}
           or p.customer_name ilike ${like})`
  const [rows, [totals]] = await Promise.all([
    sql`select p.* from erp.production_costs p ${where} order by p.last_receipt desc nulls last, p.doc_entry desc limit ${pageSize} offset ${offset}`,
    sql`select count(*) as n, coalesce(sum(produced_qty), 0) as qty, coalesce(sum(produced_kg), 0) as kg,
               coalesce(sum(material_cost), 0) as cost from erp.production_costs p ${where}`,
  ])
  const kg = num(totals?.kg)
  return {
    rows: rows.map(costRow),
    total: num(totals?.n),
    page,
    pageSize,
    totals: {
      orders: num(totals?.n),
      producedQty: num(totals?.qty),
      producedKg: round2(kg),
      materialCost: round2(num(totals?.cost)),
      costPerKg: kg ? round2(num(totals?.cost) / kg) : null,
    },
  }
}

export type MaterialMixRow = { month: string; role: string; netValue: number; issuedValue: number; returnedValue: number; issuedKg: number | null; issuedQty: number }

/** Materials into production per month and role (net of returns), oldest month first. */
export async function materialMix(sql: SapSql, from: string, to: string): Promise<MaterialMixRow[]> {
  const rows = await sql`
    select * from erp.material_mix_monthly where month between ${from}::date and ${to}::date order by month, net_value desc`
  return rows.map((row) => ({
    month: day(row.month)!,
    role: String(row.material_role),
    netValue: round2(num(row.net_value)),
    issuedValue: round2(num(row.issued_value)),
    returnedValue: round2(num(row.returned_value)),
    issuedKg: numOrNull(row.issued_kg),
    issuedQty: num(row.issued_qty),
  }))
}

export type ValuationRow = { groupName: string; whsCode: string; method: string; items: number; qty: number; value: number; customerSupplied: boolean }

const METHODS: Record<string, string> = { A: 'moving average', B: 'batch', F: 'FIFO', S: 'standard' }

/** Stock value from SAP's valuation layers by item group and warehouse, against the GL inventory accounts. */
export async function stockValuation(sql: SapSql): Promise<{ rows: ValuationRow[]; total: number; glInventory: number; wipBalance: number }> {
  const [rows, [gl]] = await Promise.all([
    sql`
      select coalesce(group_name, 'No group') as group_name, whs_code, coalesce(valuation_method, '?') as method,
             count(*) as items, sum(qty) as qty, sum(value) as value, bool_or(customer_supplied) as customer_supplied
      from erp.stock_valuation group by 1, 2, 3 order by sum(value) desc`,
    sql`
      select coalesce(sum(net) filter (where kind = 'inventory'), 0) as inventory, coalesce(sum(net) filter (where kind = 'wip'), 0) as wip
      from erp.cost_gl_monthly`,
  ])
  const list = rows.map((row) => ({
    groupName: String(row.group_name),
    whsCode: String(row.whs_code),
    method: METHODS[String(row.method)] ?? String(row.method),
    items: num(row.items),
    qty: num(row.qty),
    value: round2(num(row.value)),
    customerSupplied: Boolean(row.customer_supplied),
  }))
  return {
    rows: list,
    total: round2(list.reduce((sum, row) => sum + row.value, 0)),
    glInventory: round2(num(gl?.inventory)),
    wipBalance: round2(num(gl?.wip)),
  }
}

export type WipVarianceRow = { month: string; net: number; debit: number; credit: number }

/** SAP's Work in Progress Variance account by month (newest first) and its balance. */
export async function wipVariance(sql: SapSql, from: string, to: string): Promise<{ rows: WipVarianceRow[]; balance: number; account: string | null }> {
  const [rows, [all]] = await Promise.all([
    sql`
      select month, sum(net) as net, sum(debit) as debit, sum(credit) as credit
      from erp.wip_variance_monthly where month between ${from}::date and ${to}::date group by month order by month desc`,
    sql`select coalesce(sum(net), 0) as balance, min(account_name) as account from erp.wip_variance_monthly`,
  ])
  return {
    rows: rows.map((row) => ({ month: day(row.month)!, net: round2(num(row.net)), debit: round2(num(row.debit)), credit: round2(num(row.credit)) })),
    balance: round2(num(all?.balance)),
    account: text(all?.account),
  }
}

/** Finished-goods codes matching a code or words of a name (for the agent: "Too Yumm classic salted 60"). */
export async function findFgItems(sql: SapSql, query: string): Promise<Array<{ itemCode: string; itemName: string }>> {
  const value = query.trim()
  const exact = await sql`select item_code, item_name from erp.items where item_code = upper(${value}) and material_role = 'fg'`
  if (exact.length) return exact.map((row) => ({ itemCode: String(row.item_code), itemName: String(row.item_name) }))
  const words = value.split(/\s+/).filter((word) => word.length > 1).slice(0, 6)
  if (!words.length) return []
  const patterns = textArray(words.map((word) => `%${word.replace(/[\\%_]/g, (match) => `\\${match}`)}%`))
  const rows = await sql`
    select item_code, item_name from erp.items
    where material_role = 'fg' and (item_name || ' ' || item_code) ilike all (${patterns}::text[])
    order by item_code limit 20`
  return rows.map((row) => ({ itemCode: String(row.item_code), itemName: String(row.item_name) }))
}

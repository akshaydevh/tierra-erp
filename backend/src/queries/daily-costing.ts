import { day, num, numOrNull, text, textArray, type SapSql } from '../sap/db'
import { addDays } from '../domain/daily-report'
import { round2 } from './finance'

/**
 * The daily costing report (finance's "costing daily" sheet) from what SAP holds: per finished good received from
 * production on a day, the kg and pouches made, the sales value at the customer's invoice price, the material cost by
 * line (banana & cassava, packing, oil, flavour) and the margin on material, then LPG and the other valued consumables.
 * The sheet's power, water, labour, repairs, admin salary and fixed-cost lines are not in SAP (power, water and labour
 * are issued at ₹0; the rest are finance's own rates), so they are left out and the report says so.
 *
 * A production order's cost is what was issued to it at SAP's stock value less what came back that is not its product
 * (erp.production_movements). An order received over several days is split by the pieces received each day.
 */

export const COST_LINES = ['banana', 'packing', 'oil', 'flavour', 'other_material', 'lpg', 'consumables'] as const
export type CostLine = (typeof COST_LINES)[number]
export const MATERIAL_LINES: readonly CostLine[] = ['banana', 'packing', 'oil', 'flavour', 'other_material']
export const PRODUCTION_LINES: readonly CostLine[] = ['lpg', 'consumables']

export const COST_LINE_LABELS: Record<CostLine, string> = {
  banana: 'Cost of banana & cassava consumed',
  packing: 'Cost of packing materials consumed',
  oil: 'Cost of oil consumed',
  flavour: 'Cost of flavour consumed',
  other_material: 'Other materials (rework, misc.)',
  lpg: 'Cost of LPG consumed',
  consumables: 'Other consumables (ribbon, diesel ...)',
}

/** Lines of the finance sheet that SAP has no value for: left out of every figure. */
export const NOT_IN_SAP = [
  'Power and water (SAP issues kWh and KL to production at ₹0)',
  'Peeling, production and administrative salaries (labour is issued at ₹0; the HR files hold monthly pay, not the day)',
  'Repairs & maintenance and other fixed costs (finance\'s yearly rates per kg)',
  'Goods transportation',
  'The banana infeed / peel waste / ripened log (not in SAP): the ratio and yield here use the kg SAP issued to production',
]

export type OrderCost = {
  docEntry: number
  docNo: string
  itemCode: string
  itemName: string
  cardCode: string | null
  customerName: string | null
  /** Pieces of the order's product received on the day. */
  pouches: number
  kg: number | null
  /** The day's share of the order's cost: pieces received on the day / all pieces received. */
  share: number
  lines: Record<CostLine, number>
  bananaKg: number
  materialCost: number
  pricePerPouch: number | null
  priceSource: 'customer' | 'item' | null
  priceDate: string | null
  sales: number | null
}

export type CostingColumn = {
  itemCode: string | null
  itemName: string
  customers: string[]
  orders: string[]
  pouches: number
  kg: number | null
  pricePerPouch: number | null
  /** Sales at invoice price; pieces without a price are left out (unpricedPouches). */
  sales: number
  unpricedPouches: number
  lines: Record<CostLine, number>
  materialCost: number
  marginOnMaterial: number
  productionCost: number
  contribution: number
  bananaKg: number
}

export type DailyCostingPayload = {
  kind: 'full' | 'no_production' | 'no_data'
  date: string
  dataAsOf: string | null
  generatedAt: string
  columns: CostingColumn[]
  total: CostingColumn
  orders: OrderCost[]
  /** FG kg per kg of banana / cassava issued (SAP's issue, not the infeed log). */
  yieldPct: number | null
  bananaPerFgKg: number | null
  notes: string[]
  notInSap: string[]
}

function zeroLines(): Record<CostLine, number> {
  return Object.fromEntries(COST_LINES.map((line) => [line, 0])) as Record<CostLine, number>
}

/** Days with finished goods received from production, newest first, on or before a day. */
export async function productionDays(sql: SapSql, onOrBefore: string, limit = 1): Promise<string[]> {
  const rows = await sql`
    select distinct m.doc_date from erp.production_movements m
    join sap.owor w on w.docentry = m.production_doc_entry and w.itemcode = m.item_code and w.type <> 'D'
    where m.kind = 'receipt' and not m.cancelled and m.material_role = 'fg' and m.doc_date <= ${onOrBefore}::date
    order by m.doc_date desc limit ${limit}`
  return rows.map((row) => day(row.doc_date)!)
}

async function ordersOn(sql: SapSql, date: string): Promise<OrderCost[]> {
  const [made, costs] = await Promise.all([
    sql`
      with day_receipts as (
        select m.production_doc_entry as doc_entry, sum(m.qty) as qty
        from erp.production_movements m
        join sap.owor w on w.docentry = m.production_doc_entry and w.itemcode = m.item_code and w.type <> 'D'
        where m.kind = 'receipt' and not m.cancelled and m.material_role = 'fg' and m.doc_date = ${date}::date
        group by 1
      ),
      all_receipts as (
        select m.production_doc_entry as doc_entry, sum(m.qty) as qty
        from erp.production_movements m
        join sap.owor w on w.docentry = m.production_doc_entry and w.itemcode = m.item_code
        where m.kind = 'receipt' and not m.cancelled and m.production_doc_entry in (select doc_entry from day_receipts)
        group by 1
      )
      select o.doc_entry, o.doc_no, o.item_code, o.item_name, o.card_code, o.customer_name, i.pack_grams,
             d.qty as day_qty, a.qty as all_qty
      from day_receipts d
      join all_receipts a using (doc_entry)
      join erp.production_orders o on o.doc_entry = d.doc_entry
      left join erp.items i on i.item_code = o.item_code
      order by o.item_code, o.doc_entry`,
    sql`
      select m.production_doc_entry as doc_entry,
             case
               when i.material_role in ('raw_banana', 'raw_cassava') then 'banana'
               when i.material_role in ('laminate', 'carton', 'tape') or (i.material_role = 'other' and i.category = 'PM') then 'packing'
               when i.material_role = 'oil' then 'oil'
               when i.material_role = 'seasoning' then 'flavour'
               when i.material_role = 'consumable' and i.item_name ilike '%lpg%' then 'lpg'
               when i.material_role = 'consumable' then 'consumables'
               when i.material_role = 'overhead' then 'overhead'
               else 'other_material'
             end as line,
             sum(case when m.kind = 'issue' then m.value else -m.value end) as value,
             sum(case when m.kind = 'issue' then m.qty else -m.qty end)
               filter (where i.material_role in ('raw_banana', 'raw_cassava')) as banana_kg
      from erp.production_movements m
      join sap.owor w on w.docentry = m.production_doc_entry
      left join erp.items i on i.item_code = m.item_code
      where not m.cancelled and (m.kind = 'issue' or m.item_code <> w.itemcode)
        and m.production_doc_entry in (
          select m2.production_doc_entry from erp.production_movements m2
          join sap.owor w2 on w2.docentry = m2.production_doc_entry and w2.itemcode = m2.item_code and w2.type <> 'D'
          where m2.kind = 'receipt' and not m2.cancelled and m2.doc_date = ${date}::date)
      group by 1, 2`,
  ])
  const byOrder = new Map<number, { lines: Record<CostLine, number>; bananaKg: number }>()
  for (const row of costs) {
    const entry = byOrder.get(num(row.doc_entry)) ?? { lines: zeroLines(), bananaKg: 0 }
    const line = String(row.line)
    if (line !== 'overhead') entry.lines[line as CostLine] += num(row.value)
    entry.bananaKg += num(row.banana_kg)
    byOrder.set(num(row.doc_entry), entry)
  }
  return made.map((row) => {
    const pouches = num(row.day_qty)
    const share = num(row.all_qty) ? pouches / num(row.all_qty) : 0
    const cost = byOrder.get(num(row.doc_entry)) ?? { lines: zeroLines(), bananaKg: 0 }
    const lines = Object.fromEntries(COST_LINES.map((line) => [line, round2(cost.lines[line] * share)])) as Record<CostLine, number>
    const grams = numOrNull(row.pack_grams)
    return {
      docEntry: num(row.doc_entry),
      docNo: String(row.doc_no),
      itemCode: String(row.item_code),
      itemName: text(row.item_name) ?? String(row.item_code),
      cardCode: text(row.card_code),
      customerName: text(row.customer_name),
      pouches,
      kg: grams ? round2((pouches * grams) / 1000) : null,
      share: Math.round(share * 10_000) / 10_000,
      lines,
      bananaKg: round2(cost.bananaKg * share),
      materialCost: round2(MATERIAL_LINES.reduce((sum, line) => sum + lines[line], 0)),
      pricePerPouch: null,
      priceSource: null,
      priceDate: null,
      sales: null,
    }
  })
}

/**
 * The invoice price per piece (line total before GST / quantity) of each order's item: to the order's customer on the
 * invoice nearest the day within 90 days, else to any customer. Cancelled invoices are left out.
 */
async function priceOrders(sql: SapSql, date: string, orders: OrderCost[]): Promise<void> {
  if (!orders.length) return
  const items = textArray([...new Set(orders.map((order) => order.itemCode))])
  const from = addDays(date, -90)
  const to = addDays(date, 90)
  const rows = await sql`
    select distinct on (l.itemcode, h.cardcode) l.itemcode as item_code, h.cardcode as card_code, h.docdate as doc_date,
           l.linetotal / nullif(l.quantity, 0) as price
    from sap.inv1 l join sap.oinv h on h.docentry = l.docentry
    where h.canceled = 'N' and l.quantity > 0 and l.linetotal > 0 and l.itemcode = any(${items}::text[])
      and h.docdate between ${from}::date and ${to}::date
    order by l.itemcode, h.cardcode, abs(h.docdate - ${date}::date), h.docdate desc, h.docentry desc`
  const quotes = rows.map((row) => ({
    itemCode: String(row.item_code),
    cardCode: text(row.card_code),
    date: day(row.doc_date)!,
    price: Math.round(num(row.price) * 10_000) / 10_000,
  }))
  const distance = (quote: { date: string }) => Math.abs(Date.parse(quote.date) - Date.parse(date))
  for (const order of orders) {
    const own = quotes.find((quote) => quote.itemCode === order.itemCode && quote.cardCode === order.cardCode)
    const any = quotes.filter((quote) => quote.itemCode === order.itemCode).sort((a, b) => distance(a) - distance(b) || (a.date < b.date ? 1 : -1))[0]
    const quote = own ?? any
    if (!quote) continue
    order.pricePerPouch = quote.price
    order.priceSource = own ? 'customer' : 'item'
    order.priceDate = quote.date
    order.sales = round2(quote.price * order.pouches)
  }
}

function column(orders: OrderCost[], itemCode: string | null, itemName: string): CostingColumn {
  const lines = zeroLines()
  for (const order of orders) for (const line of COST_LINES) lines[line] += order.lines[line]
  for (const line of COST_LINES) lines[line] = round2(lines[line])
  const pouches = orders.reduce((sum, order) => sum + order.pouches, 0)
  const kgKnown = orders.every((order) => order.kg != null)
  const sales = round2(orders.reduce((sum, order) => sum + (order.sales ?? 0), 0))
  const materialCost = round2(MATERIAL_LINES.reduce((sum, line) => sum + lines[line], 0))
  const productionCost = round2(PRODUCTION_LINES.reduce((sum, line) => sum + lines[line], 0))
  const prices = [...new Set(orders.map((order) => order.pricePerPouch).filter((price): price is number => price != null))]
  const pricedPouches = orders.filter((order) => order.sales != null).reduce((sum, order) => sum + order.pouches, 0)
  return {
    itemCode,
    itemName,
    customers: [...new Set(orders.map((order) => order.customerName ?? order.cardCode ?? '').filter(Boolean))],
    orders: orders.map((order) => order.docNo),
    pouches,
    kg: kgKnown ? round2(orders.reduce((sum, order) => sum + (order.kg ?? 0), 0)) : null,
    // the SKU's price when its orders share one; mixed prices (two customers) show as the average
    pricePerPouch: itemCode == null || !pricedPouches ? null : prices.length === 1 ? prices[0]! : round2(sales / pricedPouches),
    sales,
    unpricedPouches: orders.filter((order) => order.sales == null).reduce((sum, order) => sum + order.pouches, 0),
    lines,
    materialCost,
    marginOnMaterial: round2(sales - materialCost),
    productionCost,
    contribution: round2(sales - materialCost - productionCost),
    bananaKg: round2(orders.reduce((sum, order) => sum + order.bananaKg, 0)),
  }
}

/** Per kg of finished goods; null without a kg. */
export function perKg(value: number, kg: number | null): number | null {
  return kg ? round2(value / kg) : null
}

export async function buildDailyCosting(
  sql: SapSql,
  input: { date: string; dataAsOf: string | null; now: Date },
): Promise<DailyCostingPayload> {
  const base = {
    date: input.date,
    dataAsOf: input.dataAsOf,
    generatedAt: input.now.toISOString(),
    notInSap: [...NOT_IN_SAP],
  }
  const empty = column([], null, 'Total')
  if (input.dataAsOf && input.date > input.dataAsOf) {
    return { ...base, kind: 'no_data', columns: [], total: empty, orders: [], yieldPct: null, bananaPerFgKg: null, notes: [`SAP data ends ${input.dataAsOf}: there is no production for this day yet.`] }
  }
  const orders = await ordersOn(sql, input.date)
  if (!orders.length) {
    return { ...base, kind: 'no_production', columns: [], total: empty, orders: [], yieldPct: null, bananaPerFgKg: null, notes: ['No finished goods were received from production in SAP on this day.'] }
  }
  await priceOrders(sql, input.date, orders)
  const bySku = new Map<string, OrderCost[]>()
  for (const order of orders) bySku.set(order.itemCode, [...(bySku.get(order.itemCode) ?? []), order])
  const columns = [...bySku.entries()].map(([code, list]) => column(list, code, list[0]!.itemName)).sort((a, b) => (b.kg ?? 0) - (a.kg ?? 0))
  const total = column(orders, null, 'Total')

  const notes = [
    'Material cost is what SAP issued to each production order at its stock value, less what came back to stock; an order received over several days is split by the pieces received each day.',
    'Banana & cassava is SAP\'s issued quantity at SAP\'s stock value (FIFO / batch), not the infeed log or the day\'s purchase rate.',
    'Sales value is pouches x the invoice price per pouch before GST, from the invoice to the order\'s customer nearest this day.',
  ]
  for (const order of orders) {
    if (order.priceSource === 'item') notes.push(`${order.docNo} (${order.itemCode}): no invoice to ${order.customerName ?? order.cardCode ?? 'its customer'} within 90 days; priced at another customer's invoice of ${order.priceDate}.`)
    if (order.priceSource == null) notes.push(`${order.docNo} (${order.itemCode}): no invoice within 90 days, so its ${order.pouches} pouches carry no sales value.`)
    if (order.kg == null) notes.push(`${order.itemCode}: no pack size in the item name, so it has no kg.`)
    if (order.share < 1) notes.push(`${order.docNo}: ${Math.round(order.share * 100)}% of its received pieces came in on this day, so it carries that share of its cost.`)
  }
  const fgKg = total.kg
  return {
    ...base,
    kind: 'full',
    columns,
    total,
    orders,
    yieldPct: fgKg && total.bananaKg ? round2((fgKg / total.bananaKg) * 100) : null,
    bananaPerFgKg: fgKg && total.bananaKg ? round2(total.bananaKg / fgKg) : null,
    notes,
  }
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

/** The WhatsApp caption: the day's totals in one line. */
export function costingSummary(payload: DailyCostingPayload, label: string): string {
  if (payload.kind !== 'full') return `Daily costing ${label}: ${payload.notes[0]}`
  const t = payload.total
  const kg = t.kg != null ? `${new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 }).format(t.kg)} kg` : `${inr.format(t.pouches)} pouches`
  const per = (value: number) => {
    const p = perKg(value, t.kg)
    return p != null ? ` (₹${inr.format(p)}/kg)` : ''
  }
  return `Daily costing ${label}: ${kg} made, sales ₹${inr.format(t.sales)}, material ₹${inr.format(t.materialCost)}${per(t.materialCost)}, margin on material ₹${inr.format(t.marginOnMaterial)}${per(t.marginOnMaterial)}. SAP costs only: no labour, power, water or fixed costs.`
}

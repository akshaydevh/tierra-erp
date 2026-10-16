import type { Store } from '../db/store'
import { shortPartyName } from '../domain/daily-report'
import {
  closePnl,
  customerLabelOf,
  emptyPnl,
  fyMonths,
  glLineOf,
  misSettings,
  perKgOf,
  reconcile,
  sumPnl,
  type GlLine,
  type PnlMonth,
  type Reconciliation,
} from '../domain/mis'
import { addMonths, lastDayOf, monthLabel } from '../domain/months'
import { day, num, numOrNull, text, type SapSql } from '../sap/db'
import { round2 } from './finance'
import { hrOrNull } from './payroll'

/**
 * The monthly MIS from SAP (and the HR files for labour), for the months of the financial year up to the asked month.
 * How each MIS figure is found (checked against the June 2026 MIS):
 * - production kg: finished goods received from production orders, less finished goods issued back into production
 *   (rework / repacking), at the pack size in the item name;
 * - sales value of production: those pieces at the customer's average invoice price for the SKU that month (else the
 *   nearest month within three, else any customer's), before GST;
 * - banana & cassava: what was bought in the month (the "Purchases - Agri" account), as the MIS; SAP's issues when no
 *   account matches; packing, oil, flavour and LPG: SAP's issues to production at stock value, less returns;
 * - variable and fixed costs: the GL accounts by the MIS rules (domain/mis.ts); labour from the HR payroll when it is
 *   loaded for the month (peeling, production and temporary wages, office salaries), else SAP's salary journal;
 * - other income: income accounts other than sales, and invoice lines of anything that is not a finished good.
 * Per customer, banana is shared by the banana issued to its orders, the GL costs and labour by kg, as the MIS does.
 */

export type MisCustomer = {
  label: string
  cards: string[]
  kg: number
  sales: number
  banana: number
  packing: number
  oil: number
  flavour: number
  materials: number
  mom: number
  lpg: number
  /** Other variable costs: the GL ones by kg, labour by kg, plus the consumables issued to the customer's orders. */
  otherVariable: number
  variable: number
  contribution: number
  fixed: number
  netMargin: number
}

export type MisTrend = { label: string; months: Array<{ month: string; kg: number; mom: number }>; kg: number; mom: number }
export type MisStock = { category: string; opening: number; receipts: number; issues: number; closing: number }
export type MisSale = { itemCode: string; itemName: string; qty: number; kg: number | null; value: number }
export type MisGlLine = { glCode: string; account: string; line: GlLine; amount: number }

export type MisPayload = {
  month: string
  months: string[]
  dataAsOf: string | null
  generatedAt: string
  pnl: PnlMonth[]
  fyTotal: PnlMonth
  current: PnlMonth
  reconciliation: Reconciliation | null
  customers: MisCustomer[]
  customerTotal: MisCustomer
  trend: MisTrend[]
  consumption: MisStock[]
  sales: MisSale[]
  otherSales: MisSale[]
  gl: MisGlLine[]
  notes: string[]
  /** The month is past the SAP data: the page says so instead of figures. */
  noData: boolean
}

type Key = { month: string; itemCode: string; cardCode: string | null }

const keyOf = (k: Key) => `${k.month}|${k.itemCode}|${k.cardCode ?? ''}`

async function reads(sql: SapSql, from: string, to: string) {
  const end = lastDayOf(to)
  const priceFrom = addMonths(from, -3)
  const priceTo = lastDayOf(addMonths(to, 3))
  return Promise.all([
    // finished goods received from standard production orders: the order's own product
    sql`
      select date_trunc('month', m.doc_date)::date as month, m.item_code, w.cardcode as card_code, min(c.cardname) as card_name,
             min(i.item_name) as item_name, min(i.pack_grams) as pack_grams, sum(m.qty) as qty
      from erp.production_movements m
      join sap.owor w on w.docentry = m.production_doc_entry and w.itemcode = m.item_code and w.type <> 'D'
      left join sap.ocrd c on c.cardcode = w.cardcode
      left join erp.items i on i.item_code = m.item_code
      where m.kind = 'receipt' and not m.cancelled and m.material_role = 'fg' and m.doc_date between ${from}::date and ${end}::date
      group by 1, 2, 3`,
    // finished goods issued back into production orders (rework, repacking, disassembly)
    sql`
      select date_trunc('month', m.doc_date)::date as month, m.item_code, w.cardcode as card_code, min(i.pack_grams) as pack_grams, sum(m.qty) as qty
      from erp.production_movements m
      join sap.owor w on w.docentry = m.production_doc_entry
      left join erp.items i on i.item_code = m.item_code
      where m.kind = 'issue' and not m.cancelled and m.material_role = 'fg' and m.doc_date between ${from}::date and ${end}::date
      group by 1, 2, 3`,
    // materials into production orders by MIS line, less what came back that is not the product
    sql`
      select date_trunc('month', m.doc_date)::date as month, w.itemcode as order_item, w.cardcode as card_code, min(c.cardname) as card_name,
             case
               when i.material_role in ('raw_banana', 'raw_cassava') then 'banana'
               when i.material_role in ('laminate', 'carton', 'tape') or (i.material_role = 'other' and i.category = 'PM') then 'packing'
               when i.material_role = 'oil' then 'oil'
               when i.material_role = 'seasoning' then 'flavour'
               when i.material_role = 'consumable' and (i.item_name ilike '%lpg%' or i.item_name ilike '%diesel%') then 'lpg'
               when i.material_role = 'overhead' then 'overhead'
               else 'consumables'
             end as line,
             sum(case when m.kind = 'issue' then m.value else -m.value end) as value,
             sum(case when m.kind = 'issue' then m.qty else -m.qty end) filter (where i.material_role in ('raw_banana', 'raw_cassava')) as banana_kg
      from erp.production_movements m
      join sap.owor w on w.docentry = m.production_doc_entry
      left join sap.ocrd c on c.cardcode = w.cardcode
      left join erp.items i on i.item_code = m.item_code
      where not m.cancelled and (m.kind = 'issue' or m.item_code <> w.itemcode) and coalesce(i.material_role, 'other') <> 'fg'
        and m.doc_date between ${from}::date and ${end}::date
      group by 1, 2, 3, 5`,
    // invoice prices of finished goods per month, SKU and customer (cancelled invoices left out)
    sql`
      select date_trunc('month', h.docdate)::date as month, l.itemcode as item_code, h.cardcode as card_code,
             sum(l.linetotal) as value, sum(l.quantity) as qty
      from sap.inv1 l join sap.oinv h on h.docentry = l.docentry
      join erp.items i on i.item_code = l.itemcode and i.material_role = 'fg'
      where h.canceled = 'N' and l.quantity > 0 and l.linetotal > 0 and h.docdate between ${priceFrom}::date and ${priceTo}::date
      group by 1, 2, 3`,
    // the GL: profit and loss accounts per month (period-end closing entries left out)
    sql`
      select date_trunc('month', j.refdate)::date as month, a.gl_code, a.account_name, a.side,
             sum(case when a.side = 'income' then j.credit - j.debit else j.debit - j.credit end) as amount
      from erp.pnl_accounts a join sap.jdt1 j on j.account = a.gl_code
      where j.transtype is distinct from '-3' and j.refdate between ${from}::date and ${end}::date
      group by 1, 2, 3, 4`,
    // invoice lines of what is not a finished good (scrap, raw banana ...): other income, as the MIS
    sql`
      select date_trunc('month', h.docdate)::date as month, l.itemcode as item_code, min(coalesce(i.item_name, l.dscription)) as item_name,
             sum(l.quantity) as qty, sum(l.linetotal) as value
      from sap.inv1 l join sap.oinv h on h.docentry = l.docentry
      left join erp.items i on i.item_code = l.itemcode
      where h.canceled = 'N' and coalesce(i.material_role, 'other') <> 'fg' and h.docdate between ${from}::date and ${end}::date
      group by 1, 2`,
  ])
}

async function labour(sql: SapSql, from: string, to: string) {
  return hrOrNull(
    () => sql`
      select r.month, r.source, l.category, sum(l.total_earning) as amount
      from hr.payroll_lines l join hr.payroll_runs r on r.run_id = l.run_id
      where r.source in ('register', 'temp_sheet') and r.month between ${from}::date and ${to}::date
      group by 1, 2, 3`,
  )
}

async function stockMovement(sql: SapSql, month: string): Promise<MisStock[]> {
  const end = lastDayOf(month)
  const rows = await sql`
    select case
             when i.material_role in ('raw_banana', 'raw_cassava') then 'Banana & cassava'
             when i.material_role in ('laminate', 'carton', 'tape') or (i.material_role = 'other' and i.category = 'PM') then 'Packing materials'
             when i.material_role = 'oil' then 'Oil'
             when i.material_role = 'seasoning' then 'Salt / flavours'
             when i.item_name ilike '%lpg%' then 'LPG'
             when i.item_name ilike '%diesel%' then 'Diesel'
             when i.material_role = 'fg' then 'Finished goods'
             when i.category = 'MP' or i.group_name ilike '%spare%' then 'Spares'
             when i.material_role in ('consumable', 'overhead') then 'Consumables'
             else 'Others'
           end as category,
           coalesce(sum(l.transvalue) filter (where o.docdate < ${month}::date), 0) as opening,
           coalesce(sum(l.transvalue) filter (where o.docdate >= ${month}::date and l.transvalue > 0), 0) as receipts,
           coalesce(-sum(l.transvalue) filter (where o.docdate >= ${month}::date and l.transvalue < 0), 0) as issues,
           coalesce(sum(l.transvalue), 0) as closing
    from sap.ivl1 l join sap.oivl o on o.transseq = l.transseq
    left join erp.items i on i.item_code = o.itemcode
    where o.docdate <= ${end}::date
    group by 1`
  const order = ['Banana & cassava', 'Packing materials', 'Oil', 'Salt / flavours', 'LPG', 'Diesel', 'Consumables', 'Spares', 'Finished goods', 'Others']
  return rows
    .map((row) => ({ category: String(row.category), opening: round2(num(row.opening)), receipts: round2(num(row.receipts)), issues: round2(num(row.issues)), closing: round2(num(row.closing)) }))
    .filter((row) => row.opening || row.receipts || row.issues || row.closing)
    .sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category))
}

async function salesByItem(sql: SapSql, month: string): Promise<MisSale[]> {
  const rows = await sql`
    select l.itemcode as item_code, min(i.item_name) as item_name, min(i.pack_grams) as pack_grams, sum(l.quantity) as qty, sum(l.linetotal) as value
    from sap.inv1 l join sap.oinv h on h.docentry = l.docentry
    join erp.items i on i.item_code = l.itemcode and i.material_role = 'fg'
    where h.canceled = 'N' and h.docdate between ${month}::date and ${lastDayOf(month)}::date
    group by 1 order by 5 desc`
  return rows.map((row) => {
    const grams = numOrNull(row.pack_grams)
    return {
      itemCode: String(row.item_code),
      itemName: text(row.item_name) ?? String(row.item_code),
      qty: num(row.qty),
      kg: grams ? round2((num(row.qty) * grams) / 1000) : null,
      value: round2(num(row.value)),
    }
  })
}

type Prices = { find(k: Key): number | null }

function priceBook(rows: Array<Record<string, unknown>>): Prices {
  const byKey = new Map<string, { value: number; qty: number }>()
  const byItem = new Map<string, Map<string, { value: number; qty: number }>>()
  for (const row of rows) {
    const k = { month: day(row.month)!, itemCode: String(row.item_code), cardCode: text(row.card_code) }
    byKey.set(keyOf(k), { value: num(row.value), qty: num(row.qty) })
    const months = byItem.get(k.itemCode) ?? new Map()
    const at = months.get(k.month) ?? { value: 0, qty: 0 }
    at.value += num(row.value)
    at.qty += num(row.qty)
    months.set(k.month, at)
    byItem.set(k.itemCode, months)
  }
  const price = (entry: { value: number; qty: number } | undefined) => (entry && entry.qty > 0 ? entry.value / entry.qty : null)
  return {
    find(k) {
      for (const shift of [0, -1, 1, -2, 2, -3, 3]) {
        const found = price(byKey.get(keyOf({ ...k, month: addMonths(k.month, shift) })))
        if (found != null) return found
      }
      const months = byItem.get(k.itemCode)
      for (const shift of [0, -1, 1, -2, 2, -3, 3]) {
        const found = price(months?.get(addMonths(k.month, shift)))
        if (found != null) return found
      }
      return null
    },
  }
}

type LabelMonth = { label: string; cards: Set<string>; kg: number; sales: number; bananaKg: number; issues: Record<string, number> }

export async function buildMis(
  deps: { sapSql: SapSql; store: Pick<Store, 'getSetting'> },
  input: { month: string; dataAsOf: string | null; now: Date },
): Promise<MisPayload> {
  const months = fyMonths(input.month)
  const from = months[0]!
  const to = input.month
  const settings = await misSettings(deps.store)
  const base = { month: to, months, dataAsOf: input.dataAsOf, generatedAt: input.now.toISOString() }
  if (input.dataAsOf && to > input.dataAsOf) {
    const empty = closePnl(emptyPnl(to))
    return {
      ...base,
      pnl: [],
      fyTotal: empty,
      current: empty,
      reconciliation: null,
      customers: [],
      customerTotal: totalRow(new Set(), empty),
      trend: [],
      consumption: [],
      sales: [],
      otherSales: [],
      gl: [],
      notes: [`SAP data ends ${input.dataAsOf}: there is no MIS for ${monthLabel(to)} yet.`],
      noData: true,
    }
  }

  const [[received, rework, issues, priceRows, glRows, otherRows], hr, consumption, sales] = await Promise.all([
    reads(deps.sapSql, from, to),
    labour(deps.sapSql, from, to),
    stockMovement(deps.sapSql, to),
    salesByItem(deps.sapSql, to),
  ])
  const prices = priceBook(priceRows)
  const notes: string[] = []
  const labelOf = (itemCode: string, cardCode: string | null, cardName: string | null) =>
    customerLabelOf(settings.customerRules, { itemCode, cardCode, fallback: cardName ? shortPartyName(cardName) : (cardCode ?? 'No customer') })

  // per month and MIS customer: kg, sales value, issues
  const perMonth = new Map<string, Map<string, LabelMonth>>()
  const entry = (month: string, label: string): LabelMonth => {
    const labels = perMonth.get(month) ?? new Map<string, LabelMonth>()
    perMonth.set(month, labels)
    const found = labels.get(label) ?? { label, cards: new Set(), kg: 0, sales: 0, bananaKg: 0, issues: {} }
    labels.set(label, found)
    return found
  }
  const pnl = new Map(months.map((month) => [month, emptyPnl(month)]))
  const noGrams = new Set<string>()
  const unpriced = new Set<string>()

  const reworkBy = new Map<string, number>()
  for (const row of rework) {
    const k = { month: day(row.month)!, itemCode: String(row.item_code), cardCode: text(row.card_code) }
    reworkBy.set(keyOf(k), (reworkBy.get(keyOf(k)) ?? 0) + num(row.qty))
    const grams = numOrNull(row.pack_grams)
    const p = pnl.get(k.month)
    if (p && grams) p.reworkKg += (num(row.qty) * grams) / 1000
  }
  const seen = new Set<string>()
  const addProduction = (k: Key, pieces: number, grams: number | null, cardName: string | null) => {
    const p = pnl.get(k.month)
    if (!p || !pieces) return
    if (!grams) noGrams.add(k.itemCode)
    const kg = grams ? (pieces * grams) / 1000 : 0
    const price = prices.find(k)
    if (price == null) {
      unpriced.add(k.itemCode)
      p.unpricedKg += kg
    }
    const value = price == null ? 0 : pieces * price
    const e = entry(k.month, labelOf(k.itemCode, k.cardCode, cardName))
    if (k.cardCode) e.cards.add(k.cardCode)
    e.kg += kg
    e.sales += value
    p.productionKg += kg
    p.sales += value
  }
  for (const row of received) {
    const k = { month: day(row.month)!, itemCode: String(row.item_code), cardCode: text(row.card_code) }
    seen.add(keyOf(k))
    addProduction(k, num(row.qty) - (reworkBy.get(keyOf(k)) ?? 0), numOrNull(row.pack_grams), text(row.card_name))
  }
  // rework of a SKU / customer not received in the month still comes off that month's production
  for (const row of rework) {
    const k = { month: day(row.month)!, itemCode: String(row.item_code), cardCode: text(row.card_code) }
    if (seen.has(keyOf(k))) continue
    seen.add(keyOf(k))
    addProduction(k, -(reworkBy.get(keyOf(k)) ?? 0), numOrNull(row.pack_grams), null)
  }

  const bananaIssued = new Map<string, number>()
  for (const row of issues) {
    const month = day(row.month)!
    const p = pnl.get(month)
    if (!p) continue
    const line = String(row.line)
    const value = num(row.value)
    const e = entry(month, labelOf(String(row.order_item), text(row.card_code), text(row.card_name)))
    e.issues[line] = (e.issues[line] ?? 0) + value
    e.bananaKg += num(row.banana_kg)
    p.bananaKg += num(row.banana_kg)
    if (line === 'banana') bananaIssued.set(month, (bananaIssued.get(month) ?? 0) + value)
    if (line === 'packing') p.packing += value
    if (line === 'oil') p.oil += value
    if (line === 'flavour') p.flavour += value
    if (line === 'lpg') p.lpg += value
    if (line === 'consumables') p.otherVariable += value
  }

  // the GL by the MIS rules
  const glByMonth = new Map<string, MisGlLine[]>()
  const bananaFromGl = new Set<string>()
  const salariesGl = new Map<string, number>()
  for (const row of glRows) {
    const month = day(row.month)!
    const p = pnl.get(month)
    if (!p) continue
    const side = row.side === 'income' ? 'income' : 'expense'
    const account = String(row.account_name)
    const line = glLineOf(settings.glRules, { name: account, side })
    const amount = num(row.amount)
    glByMonth.set(month, [...(glByMonth.get(month) ?? []), { glCode: String(row.gl_code), account, line, amount: round2(amount) }])
    switch (line) {
      case 'banana_cassava':
        p.banana += amount
        bananaFromGl.add(month)
        break
      case 'power': p.power += amount; break
      case 'water': p.water += amount; break
      case 'transport': p.transport += amount; break
      case 'repairs': p.repairs += amount; break
      case 'other_variable': p.otherVariable += amount; break
      case 'salaries_gl': salariesGl.set(month, (salariesGl.get(month) ?? 0) + amount); break
      case 'staff_welfare': p.staffWelfare += amount; break
      case 'professional': p.professional += amount; break
      case 'communication': p.communication += amount; break
      case 'repairs_fixed': p.repairsFixed += amount; break
      case 'conveyance': p.conveyance += amount; break
      case 'finance_charges': p.financeCharges += amount; break
      case 'interest_delayed': p.interestDelayed += amount; break
      case 'rates_taxes': p.ratesTaxes += amount; break
      case 'admin': p.admin += amount; break
      case 'gratuity': p.gratuity += amount; break
      case 'doubtful_debts': p.doubtfulDebts += amount; break
      case 'other_income': p.otherIncome += amount; break
      case 'selling': p.selling += amount; break
      default: break
    }
  }
  for (const [month, p] of pnl) if (!bananaFromGl.has(month)) p.banana += bananaIssued.get(month) ?? 0
  if (!bananaFromGl.has(to) && bananaIssued.get(to)) {
    notes.push(`No "Purchases - Agri" account in ${monthLabel(to)}: banana & cassava is SAP's issue to production at stock value.`)
  }

  const otherSales: MisSale[] = []
  for (const row of otherRows) {
    const month = day(row.month)!
    const p = pnl.get(month)
    if (!p) continue
    p.otherIncome += num(row.value)
    if (month === to) otherSales.push({ itemCode: text(row.item_code) ?? '—', itemName: text(row.item_name) ?? '—', qty: num(row.qty), kg: null, value: round2(num(row.value)) })
  }

  // labour: the HR payroll when it is loaded for the month, else SAP's salary journal as one line
  const hrByMonth = new Map<string, Record<string, number>>()
  for (const row of hr ?? []) {
    const month = day(row.month)!
    const parts = hrByMonth.get(month) ?? {}
    parts[`${row.source}:${row.category}`] = (parts[`${row.source}:${row.category}`] ?? 0) + num(row.amount)
    hrByMonth.set(month, parts)
  }
  for (const [month, p] of pnl) {
    const parts = hrByMonth.get(month)
    if (parts && Object.keys(parts).some((key) => key.startsWith('register:'))) {
      p.labourSource = 'hr'
      p.peeling += parts['register:peeling'] ?? 0
      p.wages += (parts['register:production'] ?? 0) + (parts['temp_sheet:temporary'] ?? 0)
      p.salaryFixed += parts['register:office_admin'] ?? 0
      p.selling += (parts['register:sales_promotion'] ?? 0) + (parts['temp_sheet:sales_promotion_temp'] ?? 0)
    } else if (salariesGl.get(month)) {
      p.labourSource = 'gl'
      p.wages += salariesGl.get(month)!
    }
  }

  for (const p of pnl.values()) {
    for (const key of Object.keys(p) as Array<keyof PnlMonth>) if (typeof p[key] === 'number') (p[key] as number) = round2(p[key] as number)
    closePnl(p)
  }
  const list = months.map((month) => pnl.get(month)!)
  const current = pnl.get(to)!

  // per MIS customer, the month asked for
  const customers = customersOf(perMonth.get(to), current)
  const customerTotal = totalRow(new Set(customers.flatMap((c) => c.cards)), current)

  // margin on materials per customer and month, for the comparison
  const trendMap = new Map<string, MisTrend>()
  for (const month of months) {
    for (const row of customersOf(perMonth.get(month), pnl.get(month)!)) {
      const t = trendMap.get(row.label) ?? { label: row.label, months: [], kg: 0, mom: 0 }
      t.months.push({ month, kg: row.kg, mom: row.mom })
      t.kg = round2(t.kg + row.kg)
      t.mom = round2(t.mom + row.mom)
      trendMap.set(row.label, t)
    }
  }

  if (current.labourSource === 'gl') notes.push(`Labour: the HR payroll for ${monthLabel(to)} is not loaded, so SAP's salary journal is one line under salaries & wages (no peeling or fixed-salary split).`)
  if (current.labourSource === 'none') notes.push(`Labour: no HR payroll and no salary journal in SAP for ${monthLabel(to)}, so the MIS has no labour cost.`)
  if (current.reworkKg) notes.push(`Production is net of ${round2(current.reworkKg)} kg of finished goods issued back into production (rework / repacking).`)
  if (unpriced.size) notes.push(`No invoice within three months for ${[...unpriced].join(', ')}: ${round2(current.unpricedKg)} kg this month carries no sales value.`)
  if (noGrams.size) notes.push(`No pack size in the item name of ${[...noGrams].join(', ')}: no kg.`)
  const gl = (glByMonth.get(to) ?? []).filter((row) => Math.abs(row.amount) >= 0.005)
  const unmapped = gl.filter((row) => row.line === 'unmapped')
  if (unmapped.length) {
    notes.push(`${unmapped.length} expense account${unmapped.length === 1 ? '' : 's'} with no MIS rule (₹${Math.round(unmapped.reduce((s, r) => s + r.amount, 0)).toLocaleString('en-IN')}) left out: see the GL page.`)
  }

  return {
    ...base,
    pnl: list,
    fyTotal: sumPnl(list, 'FY'),
    current,
    reconciliation: months.length > 1 ? reconcile(pnl.get(addMonths(to, -1))!, current) : null,
    customers,
    customerTotal,
    trend: [...trendMap.values()].sort((a, b) => b.kg - a.kg),
    consumption,
    sales,
    otherSales: otherSales.sort((a, b) => b.value - a.value),
    gl: gl.sort((a, b) => a.line.localeCompare(b.line) || b.amount - a.amount),
    notes,
    noData: false,
  }
}

/** The month's total as a customer row: the P&L itself. */
function totalRow(cards: Set<string>, p: PnlMonth): MisCustomer {
  return {
    label: 'Total',
    cards: [...cards],
    kg: p.productionKg,
    sales: p.sales,
    banana: p.banana,
    packing: p.packing,
    oil: p.oil,
    flavour: p.flavour,
    materials: p.materials,
    mom: p.mom,
    lpg: p.lpg,
    otherVariable: round2(p.variable - p.lpg),
    variable: p.variable,
    contribution: p.contribution,
    fixed: p.fixed,
    netMargin: round2(p.contribution - p.fixed),
  }
}

/**
 * One customer's month: packing, oil, flavour, LPG and consumables as issued to its orders; banana by its share of
 * the banana issued (by kg when none was); the other variable costs, labour and fixed costs by kg, as the MIS.
 */
function customerRow(row: LabelMonth, month: PnlMonth, consumablesIssued: number): MisCustomer {
  const kgShare = month.productionKg ? row.kg / month.productionKg : 0
  const bananaShare = month.bananaKg ? row.bananaKg / month.bananaKg : kgShare
  const issue = (line: string) => row.issues[line] ?? 0
  const banana = month.banana * bananaShare
  const materials = banana + issue('packing') + issue('oil') + issue('flavour')
  const shared = month.variable - month.lpg - consumablesIssued
  const otherVariable = shared * kgShare + issue('consumables')
  const variable = issue('lpg') + otherVariable
  const contribution = row.sales - materials - variable
  const fixed = month.fixed * kgShare
  return {
    label: row.label,
    cards: [...row.cards],
    kg: round2(row.kg),
    sales: round2(row.sales),
    banana: round2(banana),
    packing: round2(issue('packing')),
    oil: round2(issue('oil')),
    flavour: round2(issue('flavour')),
    materials: round2(materials),
    mom: round2(row.sales - materials),
    lpg: round2(issue('lpg')),
    otherVariable: round2(otherVariable),
    variable: round2(variable),
    contribution: round2(contribution),
    fixed: round2(fixed),
    netMargin: round2(contribution - fixed),
  }
}

function customersOf(labels: Map<string, LabelMonth> | undefined, month: PnlMonth): MisCustomer[] {
  const list = [...(labels?.values() ?? [])]
  const consumables = list.reduce((sum, row) => sum + (row.issues.consumables ?? 0), 0)
  return list
    .map((row) => customerRow(row, month, consumables))
    .filter((row) => row.kg || row.sales || row.materials)
    .sort((a, b) => b.kg - a.kg)
}

export function misSummary(payload: MisPayload): string {
  if (payload.noData) return `MIS ${monthLabel(payload.month)}: ${payload.notes[0]}`
  const c = payload.current
  const lakh = (n: number) => `₹${(n / 100_000).toLocaleString('en-IN', { maximumFractionDigits: 2 })}L`
  const perKg = (n: number) => {
    const p = perKgOf(n, c.productionKg)
    return p == null ? '' : ` (₹${Math.round(p)}/kg)`
  }
  return `MIS ${monthLabel(payload.month)}: ${Math.round(c.productionKg).toLocaleString('en-IN')} kg, sales value ${lakh(c.sales)}, margin on materials ${lakh(c.mom)}${perKg(c.mom)}, contribution ${lakh(c.contribution)}, EBITDA ${lakh(c.ebitda)}${perKg(c.ebitda)}.${c.labourSource === 'hr' ? '' : ' Labour from SAP\'s salary journal (HR payroll not loaded).'}`
}

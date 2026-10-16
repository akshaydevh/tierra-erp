import type { Column, Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { dayLabel } from '../domain/daily-report'
import { perKgOf, type PnlKey, type PnlMonth } from '../domain/mis'
import { monthLabel } from '../domain/months'
import { financialYear } from '../sap/db'
import type { MisCustomer, MisPayload } from '../queries/mis'
import { COMPANY, renderPdf } from './kit'

/**
 * The monthly MIS on landscape A4, in the workbook's order: the summary with the EBITDA reconciliation, the Costing
 * P&L for the financial year to date, the month per customer, the margin comparison, the consumption and sales of
 * the month, and the GL accounts behind the costs with the MIS line each went to.
 */

const GREY = '#5b6770'
const LINE = '#9aa5ab'
const HEAD_FILL = '#eef2f3'
const TOTAL_FILL = '#f6f8f8'
const KEY_FILL = '#e6f4ea'
const WARN = '#b26a00'
const CUSTOMERS_PER_TABLE = 7

const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const two = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** The Costing P&L has ~45 rows: tighter rows keep it on one landscape page. */
const compactGrid = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => LINE,
  vLineColor: () => LINE,
  paddingLeft: () => 2.5,
  paddingRight: () => 2.5,
  paddingTop: () => 0.4,
  paddingBottom: () => 0.4,
}

const grid = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => LINE,
  vLineColor: () => LINE,
  paddingLeft: () => 2.5,
  paddingRight: () => 2.5,
  paddingTop: () => 1.2,
  paddingBottom: () => 1.2,
}

const rs = (n: number | null | undefined) => (n == null ? '' : Math.abs(n) < 0.5 ? '0' : whole.format(n))
const lakh = (n: number) => two.format(n / 100_000)
const kgText = (n: number) => whole.format(n)
const rate = (n: number | null) => (n == null ? '—' : two.format(n))
const pct = (part: number, of: number) => (of ? `${two.format((part / of) * 100)}%` : '—')
const shortMonth = (month: string) => `${monthLabel(month).slice(0, 3)} ${month.slice(2, 4)}`

function head(text: string, extra: Record<string, unknown> = {}): TableCell {
  return { text, bold: true, fillColor: HEAD_FILL, alignment: 'center', ...extra } as TableCell
}

function title(text: string, breakBefore = true): Content {
  return { text, bold: true, fontSize: 10, margin: [0, 0, 0, 4], ...(breakBefore ? { pageBreak: 'before' as const } : {}) }
}

// ------------------------------------------------------------------------------------------------------ summary

type SummaryRow = { label: string; value: (p: PnlMonth) => string; bold?: boolean; fill?: string }

const SUMMARY_ROWS: SummaryRow[] = [
  { label: 'Production in kg', value: (p) => kgText(p.productionKg), bold: true },
  { label: 'Finished goods sales value (₹ lakh)', value: (p) => lakh(p.sales) },
  { label: 'Margin on materials (₹ lakh)', value: (p) => lakh(p.mom), bold: true, fill: KEY_FILL },
  { label: 'MoM %', value: (p) => pct(p.mom, p.sales) },
  { label: 'Contribution (₹ lakh)', value: (p) => lakh(p.contribution) },
  { label: 'Contribution / kg', value: (p) => rate(perKgOf(p.contribution, p.productionKg)) },
  { label: 'Fixed costs (₹ lakh)', value: (p) => lakh(p.fixed) },
  { label: 'EBITDA (₹ lakh)', value: (p) => lakh(p.ebitda), bold: true, fill: KEY_FILL },
  { label: 'EBITDA / kg', value: (p) => rate(perKgOf(p.ebitda, p.productionKg)) },
  { label: 'EBITDA %', value: (p) => pct(p.ebitda, p.sales) },
]

function monthTable(payload: MisPayload, rows: Array<{ label: string; value: (p: PnlMonth) => string; bold?: boolean; fill?: string; section?: boolean }>, compact = false): Content {
  const columns = [...payload.pnl, payload.fyTotal]
  const body: TableCell[][] = [
    [head('Particulars', { alignment: 'left' }), ...payload.pnl.map((p) => head(shortMonth(p.month))), head(`FY ${financialYear(payload.month)}`)],
  ]
  for (const row of rows) {
    if (row.section) {
      body.push([{ text: row.label, bold: true, colSpan: columns.length + 1, fillColor: HEAD_FILL }, ...columns.map(() => ({}))])
      continue
    }
    body.push([
      { text: row.label, bold: row.bold, fillColor: row.fill },
      ...columns.map((p, i): TableCell => ({ text: row.value(p), alignment: 'right', bold: row.bold || i === columns.length - 1, fillColor: row.fill ?? (i === columns.length - 1 ? TOTAL_FILL : undefined) })),
    ])
  }
  return { table: { headerRows: 1, widths: [150, ...columns.map(() => '*' as const)], body }, layout: compact ? compactGrid : grid, fontSize: compact ? 6.6 : 7 }
}

function summaryPage(payload: MisPayload): Content[] {
  const content: Content[] = [title('Summary', false), monthTable(payload, SUMMARY_ROWS)]
  if (payload.reconciliation) {
    content.push({
      margin: [0, 10, 0, 0],
      columns: [
        {
          width: 340,
          stack: [
            { text: 'EBITDA reconciliation', bold: true, margin: [0, 0, 0, 2] },
            {
              table: {
                widths: ['*', 80],
                body: [
                  [head('Particulars', { alignment: 'left' }), head('₹')],
                  ...payload.reconciliation.map((step, i, all): TableCell[] => {
                    const edge = i === 0 || i === all.length - 1
                    return [{ text: step.label, bold: edge }, { text: rs(step.amount), alignment: 'right', bold: edge, fillColor: edge ? KEY_FILL : undefined }]
                  }),
                ],
              },
              layout: grid,
            },
          ],
        },
        { width: '*', stack: [notesStack(payload)] },
      ],
      columnGap: 14,
    })
  } else {
    content.push({ margin: [0, 10, 0, 0], stack: [notesStack(payload)] })
  }
  return content
}

// ------------------------------------------------------------------------------------------------- costing P&L

const amountRow = (label: string, key: PnlKey, extra: { bold?: boolean; fill?: string } = {}) => ({ label, value: (p: PnlMonth) => rs(p[key]), ...extra })

function pnlRows(payload: MisPayload) {
  const used = (key: PnlKey) => payload.pnl.some((p) => p[key] !== 0)
  // a cost line that is zero in every month is left out; totals and the key lines always print
  const optional = (label: string, key: PnlKey) => (used(key) ? [amountRow(label, key)] : [])
  const labourGl = payload.pnl.some((p) => p.labourSource === 'gl')
  return [
    { label: 'Production in kg', value: (p: PnlMonth) => kgText(p.productionKg), bold: true },
    amountRow('Sales value', 'sales', { bold: true }),
    amountRow('Other income', 'otherIncome'),
    { label: 'Raw materials', value: () => '', section: true },
    amountRow('Banana & cassava consumed', 'banana'),
    amountRow('Packing materials consumed', 'packing'),
    amountRow('Oil consumed', 'oil'),
    amountRow('Salt / flavours consumed', 'flavour'),
    amountRow('Cost of materials consumed', 'materials', { bold: true, fill: TOTAL_FILL }),
    amountRow('Margin on materials', 'mom', { bold: true, fill: KEY_FILL }),
    { label: 'Selling price / kg', value: (p: PnlMonth) => rate(perKgOf(p.sales, p.productionKg)) },
    { label: 'Material cost / kg', value: (p: PnlMonth) => rate(perKgOf(p.materials, p.productionKg)) },
    { label: 'MoM / kg', value: (p: PnlMonth) => rate(perKgOf(p.mom, p.productionKg)) },
    { label: 'MoM %', value: (p: PnlMonth) => pct(p.mom, p.sales) },
    { label: 'Variable costs', value: () => '', section: true },
    ...optional('Diesel / LPG consumed', 'lpg'),
    ...optional('Power consumed', 'power'),
    ...optional('Peeling cost', 'peeling'),
    ...optional('Water consumed', 'water'),
    ...optional('Goods transportation charges', 'transport'),
    amountRow(labourGl ? 'Salaries & wages (SAP journal where no HR payroll)' : 'Salaries & wages', 'wages'),
    ...optional('Repairs & maintenance', 'repairs'),
    ...optional('Other variable costs', 'otherVariable'),
    amountRow('Variable cost total', 'variable', { bold: true, fill: TOTAL_FILL }),
    amountRow('Contribution', 'contribution', { bold: true, fill: KEY_FILL }),
    { label: 'Variable cost / kg', value: (p: PnlMonth) => rate(perKgOf(p.variable, p.productionKg)) },
    { label: 'Contribution / kg', value: (p: PnlMonth) => rate(perKgOf(p.contribution, p.productionKg)) },
    { label: 'Fixed costs', value: () => '', section: true },
    ...optional('Salary & wages (office)', 'salaryFixed'),
    ...optional('Staff welfare', 'staffWelfare'),
    ...optional('Professional & legal', 'professional'),
    ...optional('Communication', 'communication'),
    ...optional('Repairs & maintenance (office, building)', 'repairsFixed'),
    ...optional('Conveyance', 'conveyance'),
    ...optional('Finance charges', 'financeCharges'),
    ...optional('Interest on delayed payments to suppliers', 'interestDelayed'),
    ...optional('Rates and taxes', 'ratesTaxes'),
    ...optional('Administrative expenses', 'admin'),
    ...optional('Provision for gratuity', 'gratuity'),
    ...optional('Provision for doubtful debts', 'doubtfulDebts'),
    amountRow('Fixed cost total', 'fixed', { bold: true, fill: TOTAL_FILL }),
    amountRow('EBITDA', 'ebitda', { bold: true, fill: KEY_FILL }),
    { label: 'Fixed cost / kg', value: (p: PnlMonth) => rate(perKgOf(p.fixed, p.productionKg)) },
    { label: 'EBITDA / kg', value: (p: PnlMonth) => rate(perKgOf(p.ebitda, p.productionKg)) },
    { label: 'EBITDA %', value: (p: PnlMonth) => pct(p.ebitda, p.sales) },
    ...(used('selling') ? [amountRow('Memo: sales promotion (outside EBITDA)', 'selling')] : []),
  ]
}

// ---------------------------------------------------------------------------------------------- per customer

type CustomerLine = { label: string; value: (c: MisCustomer) => string; bold?: boolean; fill?: string }

const CUSTOMER_ROWS: CustomerLine[] = [
  { label: 'Production in kg', value: (c) => kgText(c.kg), bold: true },
  { label: 'Sale value of production', value: (c) => rs(c.sales), bold: true },
  { label: 'Banana & cassava', value: (c) => rs(c.banana) },
  { label: 'Oil', value: (c) => rs(c.oil) },
  { label: 'Flavours & salt', value: (c) => rs(c.flavour) },
  { label: 'Packing materials', value: (c) => rs(c.packing) },
  { label: 'Materials total', value: (c) => rs(c.materials), bold: true, fill: TOTAL_FILL },
  { label: 'Gross margin (MoM)', value: (c) => rs(c.mom), bold: true, fill: KEY_FILL },
  { label: 'MoM / kg', value: (c) => rate(perKgOf(c.mom, c.kg)) },
  { label: 'Diesel / LPG', value: (c) => rs(c.lpg) },
  { label: 'Other variable costs & labour', value: (c) => rs(c.otherVariable) },
  { label: 'Contribution', value: (c) => rs(c.contribution), bold: true, fill: KEY_FILL },
  { label: 'Contribution / kg', value: (c) => rate(perKgOf(c.contribution, c.kg)) },
  { label: 'Fixed costs', value: (c) => rs(c.fixed) },
  { label: 'Net margin', value: (c) => rs(c.netMargin), bold: true },
  { label: 'Net margin / kg', value: (c) => rate(perKgOf(c.netMargin, c.kg)) },
]

function customerTables(payload: MisPayload): Content[] {
  const all = payload.customers
  if (!all.length) return [{ text: 'No production in this month.', italics: true, color: GREY }]
  const out: Content[] = []
  for (let start = 0; start < all.length; start += CUSTOMERS_PER_TABLE) {
    const chunk = all.slice(start, start + CUSTOMERS_PER_TABLE)
    const columns = start + CUSTOMERS_PER_TABLE >= all.length ? [...chunk, payload.customerTotal] : chunk
    const body: TableCell[][] = [[head('Particulars', { alignment: 'left' }), ...columns.map((c) => head(c.label, { fontSize: 6.5 }))]]
    for (const row of CUSTOMER_ROWS) {
      body.push([{ text: row.label, bold: row.bold, fillColor: row.fill }, ...columns.map((c, i): TableCell => ({ text: row.value(c), alignment: 'right', bold: row.bold, fillColor: row.fill ?? (c.label === 'Total' && i === columns.length - 1 ? TOTAL_FILL : undefined) }))])
    }
    out.push({ margin: [0, 0, 0, 6], table: { headerRows: 1, widths: [130, ...columns.map(() => '*' as const)], body }, layout: grid })
  }
  out.push({ text: 'Packing, oil, flavour and LPG as issued to each customer\'s production orders; banana by its share of the banana issued; the other costs and labour by kg. Other income is not shared out.', fontSize: 6.5, color: GREY })
  return out
}

function comparisonTable(payload: MisPayload): Content {
  const months = payload.months
  const body: TableCell[][] = [
    [head('Customer', { alignment: 'left', rowSpan: 2 }), head('MoM / kg by month', { colSpan: months.length }), ...months.slice(1).map(() => ({})), head('Financial year to date', { colSpan: 3 }), {}, {}],
    [{}, ...months.map((m) => head(shortMonth(m), { fontSize: 6.5 })), head('Kg', { fontSize: 6.5 }), head('MoM ₹', { fontSize: 6.5 }), head('MoM / kg', { fontSize: 6.5 })],
  ]
  for (const t of payload.trend) {
    const at = new Map(t.months.map((m) => [m.month, m]))
    body.push([
      { text: t.label },
      ...months.map((m): TableCell => {
        const v = at.get(m)
        return { text: v && v.kg ? rate(perKgOf(v.mom, v.kg)) : '', alignment: 'right' }
      }),
      { text: kgText(t.kg), alignment: 'right', fillColor: TOTAL_FILL },
      { text: rs(t.mom), alignment: 'right', fillColor: TOTAL_FILL },
      { text: rate(perKgOf(t.mom, t.kg)), alignment: 'right', bold: true, fillColor: TOTAL_FILL },
    ])
  }
  const total = payload.fyTotal
  body.push([
    { text: 'Total', bold: true },
    ...payload.pnl.map((p): TableCell => ({ text: rate(perKgOf(p.mom, p.productionKg)), alignment: 'right', bold: true })),
    { text: kgText(total.productionKg), alignment: 'right', bold: true, fillColor: TOTAL_FILL },
    { text: rs(total.mom), alignment: 'right', bold: true, fillColor: TOTAL_FILL },
    { text: rate(perKgOf(total.mom, total.productionKg)), alignment: 'right', bold: true, fillColor: KEY_FILL },
  ])
  return { table: { headerRows: 2, widths: [100, ...months.map(() => '*' as const), 46, 56, 40], body }, layout: grid }
}

// ------------------------------------------------------------------------------------------ consumption, sales

function consumptionTable(payload: MisPayload): Column {
  const body: TableCell[][] = [['Category', 'Opening stock', 'Receipts', 'Issues', 'Closing stock'].map((t, i) => head(t, i ? {} : { alignment: 'left' }))]
  for (const row of payload.consumption) {
    body.push([{ text: row.category }, ...[row.opening, row.receipts, row.issues, row.closing].map((v): TableCell => ({ text: rs(v), alignment: 'right' }))])
  }
  return {
    width: 330,
    stack: [
      { text: `Stock movement, ${monthLabel(payload.month)} (SAP stock value)`, bold: true, margin: [0, 0, 0, 2] },
      { table: { headerRows: 1, widths: ['*', 62, 58, 58, 62], body }, layout: grid },
      { text: 'Receipts and issues include transfers and revaluations; finished goods are at cost.', fontSize: 6.5, color: GREY, margin: [0, 2, 0, 0] },
    ],
  }
}

function salesTable(payload: MisPayload): Column {
  const body: TableCell[][] = [['Item', 'Description', 'Qty', 'Kg', 'Value'].map((t, i) => head(t, i < 2 ? { alignment: 'left' } : {}))]
  for (const row of payload.sales) {
    body.push([{ text: row.itemCode, fontSize: 6.5 }, { text: row.itemName, fontSize: 6.5 }, { text: whole.format(row.qty), alignment: 'right' }, { text: row.kg != null ? two.format(row.kg) : '—', alignment: 'right' }, { text: rs(row.value), alignment: 'right' }])
  }
  const kg = payload.sales.reduce((s, r) => s + (r.kg ?? 0), 0)
  const value = payload.sales.reduce((s, r) => s + r.value, 0)
  body.push([{ text: 'Finished goods', bold: true, colSpan: 3 }, {}, {}, { text: two.format(kg), alignment: 'right', bold: true }, { text: rs(value), alignment: 'right', bold: true }])
  for (const row of payload.otherSales) {
    body.push([{ text: row.itemCode, fontSize: 6.5, color: GREY }, { text: `${row.itemName} (other income)`, fontSize: 6.5, color: GREY }, { text: whole.format(row.qty), alignment: 'right', color: GREY }, { text: '', alignment: 'right' }, { text: rs(row.value), alignment: 'right', color: GREY }])
  }
  return {
    width: '*',
    stack: [
      { text: `Sales by item, ${monthLabel(payload.month)} (invoices before GST)`, bold: true, margin: [0, 0, 0, 2] },
      { table: { headerRows: 1, widths: [62, '*', 44, 44, 60], body }, layout: grid },
    ],
  }
}

// ------------------------------------------------------------------------------------------------------- GL

const LINE_NAMES: Record<string, string> = {
  banana_cassava: 'Banana & cassava',
  power: 'Power',
  water: 'Water',
  transport: 'Goods transportation',
  repairs: 'Repairs & maintenance',
  other_variable: 'Other variable costs',
  salaries_gl: 'Salaries & wages (SAP journal)',
  staff_welfare: 'Staff welfare',
  professional: 'Professional & legal',
  communication: 'Communication',
  repairs_fixed: 'R&M (office, building)',
  conveyance: 'Conveyance',
  finance_charges: 'Finance charges',
  interest_delayed: 'Interest on delayed payments',
  rates_taxes: 'Rates and taxes',
  admin: 'Administrative',
  gratuity: 'Gratuity',
  doubtful_debts: 'Doubtful debts',
  other_income: 'Other income',
  selling: 'Sales promotion (memo)',
  ignore: 'Not a MIS cost (stock, sales, WIP)',
  unmapped: 'NO RULE: left out',
}

function glTable(payload: MisPayload): Content {
  const order = (line: string) => (line === 'unmapped' ? 0 : line === 'ignore' ? 2 : 1)
  const rows = [...payload.gl].sort((a, b) => order(a.line) - order(b.line) || a.line.localeCompare(b.line) || b.amount - a.amount)
  const hrNote = payload.current.labourSource === 'hr' ? ' Salary accounts are left out: labour comes from the HR payroll.' : ''
  const body: TableCell[][] = [['GL code', 'Account', 'MIS line', 'Amount'].map((t, i) => head(t, i < 3 ? { alignment: 'left' } : {}))]
  for (const row of rows) {
    const warn = row.line === 'unmapped'
    body.push([
      { text: row.glCode, fontSize: 6.5 },
      { text: row.account },
      { text: LINE_NAMES[row.line] ?? row.line, color: warn ? WARN : row.line === 'ignore' ? GREY : undefined, bold: warn },
      { text: rs(row.amount), alignment: 'right' },
    ])
  }
  return {
    stack: [
      { table: { headerRows: 1, widths: [80, '*', 150, 70], body }, layout: grid },
      { text: `Profit and loss accounts of ${monthLabel(payload.month)} by the MIS rules (the MIS settings, /api/reports/mis-settings: first match wins).${hrNote}`, fontSize: 6.5, color: GREY, margin: [0, 2, 0, 0] },
    ],
  }
}

function notesStack(payload: MisPayload): Content {
  return {
    fontSize: 6.8,
    color: GREY,
    stack: [
      { text: 'How this MIS is built', bold: true },
      {
        ul: [
          'Production: finished goods received from production orders less those issued back into production (rework), at the pack size in the item name.',
          'Sales value: those pieces at the customer\'s average invoice price for the SKU that month (else the nearest month within three, else any customer\'s), before GST.',
          'Banana & cassava: the month\'s "Purchases - Agri"; packing, oil, flavour and LPG: SAP\'s issues to production at stock value, less returns.',
          'Costs: SAP GL accounts by the MIS rules; labour from the HR payroll when loaded for the month.',
          'Figures are SAP as of the data date: postings made later for the month change them.',
        ],
      },
      ...(payload.notes.length ? [{ text: 'This month', bold: true, margin: [0, 3, 0, 0] } as Content, { ul: [...payload.notes] } as Content] : []),
    ],
  }
}

function titleBlock(payload: MisPayload): Content[] {
  const generated = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(payload.generatedAt))
  return [
    { text: COMPANY.name.toUpperCase(), bold: true, fontSize: 13, alignment: 'center' },
    { text: `MONTHLY MIS · ${monthLabel(payload.month).toUpperCase()}`, bold: true, fontSize: 11, alignment: 'center', margin: [0, 1, 0, 1] },
    { text: `SAP data as of ${payload.dataAsOf ? dayLabel(payload.dataAsOf) : '—'} · generated ${generated} IST · amounts in ₹`, fontSize: 7, color: GREY, alignment: 'center', margin: [0, 0, 0, 8] },
  ]
}

export function misDefinition(payload: MisPayload): TDocumentDefinitions {
  const content: Content[] = [...titleBlock(payload)]
  if (payload.noData) {
    content.push({ text: payload.notes[0] ?? 'No SAP data for this month.', bold: true, color: WARN, alignment: 'center', margin: [0, 16, 0, 0] })
  } else {
    content.push(
      ...summaryPage(payload),
      title('Costing profit and loss statement'),
      monthTable(payload, pnlRows(payload), true),
      title(`Customer-wise, ${monthLabel(payload.month)}`),
      ...customerTables(payload),
      title('Customer-wise margin comparison'),
      comparisonTable(payload),
      title(`Consumption and sales, ${monthLabel(payload.month)}`),
      { columns: [consumptionTable(payload), salesTable(payload)], columnGap: 12 },
      title(`GL accounts, ${monthLabel(payload.month)}`),
      glTable(payload),
    )
  }
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [24, 22, 24, 26],
    info: { title: `MIS ${monthLabel(payload.month)}`, author: COMPANY.name },
    defaultStyle: { fontSize: 7 },
    footer: (page, pages) => ({ text: `MIS ${monthLabel(payload.month)} · page ${page} of ${pages}`, alignment: 'center', fontSize: 6.5, color: GREY }),
    content,
  }
}

export function renderMisPdf(payload: MisPayload): Promise<Buffer> {
  return renderPdf(misDefinition(payload))
}

export function misFileName(payload: Pick<MisPayload, 'month'>): string {
  return `mis-${payload.month.slice(0, 7)}.pdf`
}

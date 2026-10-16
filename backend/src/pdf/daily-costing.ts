import type { Column, Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { ddmmyyyy, dayLabel, shortPartyName } from '../domain/daily-report'
import { COST_LINE_LABELS, perKg, type CostingColumn, type CostLine, type DailyCostingPayload } from '../queries/daily-costing'
import { COMPANY, renderPdf } from './kit'

/**
 * The daily costing report on landscape A4, laid out like finance's costing sheet: one column pair (value, per kg)
 * per finished good made that day and the total, with the sheet's rows from production kg down to the contribution
 * after the costs SAP values. Then the production orders behind it, the banana ratio and the notes, including the
 * sheet's lines SAP cannot give (labour, power, water, fixed costs), which are left out of every figure.
 */

const GREY = '#5b6770'
const LINE = '#9aa5ab'
const HEAD_FILL = '#eef2f3'
const TOTAL_FILL = '#f6f8f8'
const KEY_FILL = '#e6f4ea'
/** SKU columns per table; a day with more SKUs prints further tables, the total column on the last. */
const PER_TABLE = 5

const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
const rate = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const kgFormat = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const count = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

const gridLayout = {
  hLineWidth: () => 0.5,
  vLineWidth: () => 0.5,
  hLineColor: () => LINE,
  vLineColor: () => LINE,
  paddingLeft: () => 3,
  paddingRight: () => 3,
  paddingTop: () => 1.5,
  paddingBottom: () => 1.5,
}

type Row = {
  label: string
  value: (column: CostingColumn) => string
  perKg?: (column: CostingColumn) => number | null
  bold?: boolean
  fill?: string
  section?: boolean
}

function amount(value: number): string {
  return Math.abs(value) < 0.5 ? '0' : money.format(value)
}

function costRow(line: CostLine): Row {
  return { label: COST_LINE_LABELS[line], value: (c) => amount(c.lines[line]), perKg: (c) => perKg(c.lines[line], c.kg) }
}

function rows(payload: DailyCostingPayload): Row[] {
  const used = (line: CostLine) => payload.total.lines[line] !== 0
  return [
    { label: 'Production in kg', value: (c) => (c.kg != null ? kgFormat.format(c.kg) : '—'), bold: true },
    { label: 'Pouches', value: (c) => count.format(c.pouches) },
    { label: 'Selling price per pouch', value: (c) => (c.pricePerPouch != null ? rate.format(c.pricePerPouch) : c.itemCode ? 'no invoice' : '') },
    { label: 'Sales value', value: (c) => amount(c.sales), perKg: (c) => perKg(c.sales, c.kg), bold: true },
    { label: 'Material cost', value: () => '', section: true },
    costRow('banana'),
    costRow('packing'),
    costRow('oil'),
    costRow('flavour'),
    ...(used('other_material') ? [costRow('other_material')] : []),
    { label: 'Total material cost', value: (c) => amount(c.materialCost), perKg: (c) => perKg(c.materialCost, c.kg), bold: true, fill: TOTAL_FILL },
    { label: 'Margin on material', value: (c) => amount(c.marginOnMaterial), perKg: (c) => perKg(c.marginOnMaterial, c.kg), bold: true, fill: KEY_FILL },
    { label: 'Other production cost (valued in SAP)', value: () => '', section: true },
    costRow('lpg'),
    ...(used('consumables') ? [costRow('consumables')] : []),
    { label: 'Production cost total', value: (c) => amount(c.productionCost), perKg: (c) => perKg(c.productionCost, c.kg), bold: true, fill: TOTAL_FILL },
    { label: 'Contribution (after SAP costs only)', value: (c) => amount(c.contribution), perKg: (c) => perKg(c.contribution, c.kg), bold: true, fill: KEY_FILL },
  ]
}

function head(text: string, extra: Record<string, unknown> = {}): TableCell {
  return { text, bold: true, fillColor: HEAD_FILL, alignment: 'center', ...extra } as TableCell
}

function costTable(payload: DailyCostingPayload, columns: CostingColumn[]): Content {
  const body: TableCell[][] = []
  body.push([
    head('Particulars', { rowSpan: 3, alignment: 'left' }),
    ...columns.flatMap((c): TableCell[] => [head(c.itemCode ? c.itemName : 'Total', { colSpan: 2, fontSize: 7 }), {}]),
  ])
  body.push([
    {},
    ...columns.flatMap((c): TableCell[] => [
      head(c.itemCode ? [c.itemCode, ...c.customers.map(shortPartyName)].join(' · ') : 'All SKUs', { colSpan: 2, bold: false, fontSize: 6, color: GREY }),
      {},
    ]),
  ])
  body.push([{}, ...columns.flatMap((): TableCell[] => [head('Value', { fontSize: 6.5 }), head('Per kg', { fontSize: 6.5 })])])
  for (const row of rows(payload)) {
    if (row.section) {
      body.push([{ text: row.label, bold: true, colSpan: 1 + columns.length * 2, fillColor: HEAD_FILL, fontSize: 7 }, ...columns.flatMap((): TableCell[] => [{}, {}])])
      continue
    }
    body.push([
      { text: row.label, bold: row.bold, fillColor: row.fill },
      ...columns.flatMap((c): TableCell[] => {
        const per = row.perKg?.(c)
        return [
          { text: row.value(c), alignment: 'right', bold: row.bold, fillColor: row.fill },
          { text: per != null ? rate.format(per) : '', alignment: 'right', color: GREY, fillColor: row.fill },
        ]
      }),
    ])
  }
  return {
    margin: [0, 6, 0, 0],
    table: { headerRows: 3, widths: ['*', ...columns.flatMap(() => [62, 40])], body },
    layout: gridLayout,
  }
}

function ordersTable(payload: DailyCostingPayload): Column {
  const body: TableCell[][] = [
    ['Order', 'Item', 'Customer', 'Pouches', 'Kg', 'Banana kg issued', 'Material cost', 'Per kg', 'Price / pouch', 'Price from'].map((text) => head(text, { fontSize: 6.5 })),
  ]
  for (const order of payload.orders) {
    body.push([
      { text: order.docNo },
      { text: order.itemCode },
      { text: order.customerName ? shortPartyName(order.customerName) : (order.cardCode ?? '') },
      { text: count.format(order.pouches), alignment: 'right' },
      { text: order.kg != null ? kgFormat.format(order.kg) : '—', alignment: 'right' },
      { text: order.bananaKg ? kgFormat.format(order.bananaKg) : '', alignment: 'right' },
      { text: amount(order.materialCost), alignment: 'right' },
      { text: perKg(order.materialCost, order.kg) != null ? rate.format(perKg(order.materialCost, order.kg)!) : '', alignment: 'right' },
      { text: order.pricePerPouch != null ? rate.format(order.pricePerPouch) : '—', alignment: 'right' },
      { text: order.priceDate ? `${order.priceSource === 'item' ? 'other customer, ' : ''}${ddmmyyyy(order.priceDate)}` : 'no invoice', fontSize: 6.5 },
    ])
  }
  return {
    width: '*',
    stack: [
      { text: 'Production orders received on this day', bold: true, margin: [0, 0, 0, 2] },
      { table: { headerRows: 1, widths: [58, 62, '*', 40, 40, 44, 50, 34, 34, 70], body }, layout: gridLayout },
    ],
  }
}

function ratioTable(payload: DailyCostingPayload): Column {
  const t = payload.total
  const line = (label: string, value: string): TableCell[] => [{ text: label }, { text: value, alignment: 'right', bold: true }]
  return {
    width: 170,
    stack: [
      { text: 'Banana / cassava vs FG (SAP issue)', bold: true, margin: [0, 0, 0, 2] },
      {
        table: {
          widths: ['*', 60],
          body: [
            line('Issued to production (kg)', t.bananaKg ? kgFormat.format(t.bananaKg) : '—'),
            line('Finished goods (kg)', t.kg != null ? kgFormat.format(t.kg) : '—'),
            line('Ratio (raw kg per FG kg)', payload.bananaPerFgKg != null ? rate.format(payload.bananaPerFgKg) : '—'),
            line('Yield', payload.yieldPct != null ? `${rate.format(payload.yieldPct)}%` : '—'),
          ],
        },
        layout: gridLayout,
      },
    ],
  }
}

function titleBlock(payload: DailyCostingPayload): Content[] {
  const generated = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(payload.generatedAt))
  return [
    { text: COMPANY.name.toUpperCase(), bold: true, fontSize: 13, alignment: 'center' },
    { text: 'DAILY COSTING REPORT', bold: true, fontSize: 11, alignment: 'center', margin: [0, 1, 0, 1] },
    { text: `Production date ${ddmmyyyy(payload.date)}`, bold: true, alignment: 'center' },
    {
      text: `SAP data as of ${payload.dataAsOf ? dayLabel(payload.dataAsOf) : '—'} · generated ${generated} IST · amounts in ₹`,
      fontSize: 7,
      color: GREY,
      alignment: 'center',
      margin: [0, 0, 0, 2],
    },
  ]
}

function notesBlock(payload: DailyCostingPayload): Content {
  return {
    margin: [0, 8, 0, 0],
    fontSize: 6.5,
    color: GREY,
    stack: [
      { text: 'Notes', bold: true },
      { ul: payload.kind === 'full' ? payload.notes : payload.notes.slice(1) },
      { text: 'Not in SAP, so left out of every figure (the finance sheet adds these)', bold: true, margin: [0, 3, 0, 0] },
      { ul: payload.notInSap },
    ],
  }
}

export function dailyCostingDefinition(payload: DailyCostingPayload): TDocumentDefinitions {
  const content: Content[] = [...titleBlock(payload)]
  if (payload.kind !== 'full') {
    content.push({ text: payload.notes[0] ?? 'No production on this day.', bold: true, color: '#b26a00', alignment: 'center', margin: [0, 16, 0, 0] })
  } else {
    const all = payload.columns
    for (let start = 0; start < all.length; start += PER_TABLE) {
      const chunk = all.slice(start, start + PER_TABLE)
      const last = start + PER_TABLE >= all.length
      // one SKU: its column is the total, so it is not printed twice
      content.push(costTable(payload, last && all.length > 1 ? [...chunk, payload.total] : chunk))
    }
    content.push({ columns: [ordersTable(payload), ratioTable(payload)], columnGap: 12, margin: [0, 10, 0, 0] })
  }
  content.push(notesBlock(payload))
  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 24, 28, 24],
    info: { title: `Daily costing ${ddmmyyyy(payload.date)}`, author: COMPANY.name },
    defaultStyle: { fontSize: 7.5 },
    content,
  }
}

export function renderDailyCostingPdf(payload: DailyCostingPayload): Promise<Buffer> {
  return renderPdf(dailyCostingDefinition(payload))
}

export function dailyCostingFileName(payload: Pick<DailyCostingPayload, 'date'>): string {
  return `daily-costing-${payload.date}.pdf`
}

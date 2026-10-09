import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import { MANPOWER_KEYS, MANPOWER_LABELS } from '../db/types'
import { basisLabel, ddmmyyyy, dayLabel, type DailyReportPayload, type ReportLine } from '../domain/daily-report'
import { COMPANY, renderPdf } from './kit'

/**
 * The daily report as one A4 page laid out like the manual sheet (daily-report.md §2): title, the date with the
 * production / packing / cartoning flags, the manpower row with its total, opening and closing per bank, receipts
 * beside payments with their totals, inwards beside outwards with the day total and the month to date, then the
 * footnotes. The sheet's merged cells are colSpans here; the house bank's column (SBI) is highlighted as on the sheet.
 */

const GREY = '#5b6770'
const LINE = '#9aa5ab'
const HEAD_FILL = '#eef2f3'
const HOUSE_FILL = '#bde9fb'
const MIN_LINE_ROWS = 6

const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const count = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })

function amount(value: number | null | undefined, blankZero = false): string {
  if (value == null || (blankZero && Math.abs(value) < 0.005)) return ''
  return money.format(value)
}

function yesNo(value: boolean | null): string {
  if (value == null) return '—'
  return value ? 'Yes' : 'No'
}

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

function head(text: string, extra: Partial<TableCell & object> = {}): TableCell {
  return { text, bold: true, fillColor: HEAD_FILL, ...extra } as TableCell
}

function sectionTitle(text: string, colSpan: number): TableCell[] {
  return [{ text, bold: true, colSpan, alignment: 'center', fillColor: HEAD_FILL }, ...Array.from({ length: colSpan - 1 }, () => ({}))]
}

/** The PDF can only print what its font has: arrows are not in Noto Sans, so a transfer names its direction. */
function printable(line: ReportLine, side: 'in' | 'out'): string {
  if (!line.transfer) return line.label
  return line.label.replace(/^Transfer ⇄ /, side === 'in' ? 'Transfer from ' : 'Transfer to ')
}

function titleBlock(payload: DailyReportPayload): Content[] {
  const flags = payload.activity
  const flagTable: Content = {
    table: {
      widths: [40, 70, '*', '*', '*'],
      body: [
        [
          head('Date', { rowSpan: 2, alignment: 'center' }),
          { text: ddmmyyyy(payload.reportDate), rowSpan: 2, bold: true, alignment: 'center', fontSize: 10 },
          head('Production', { alignment: 'center' }),
          head('Packing', { alignment: 'center' }),
          head('Cartoning', { alignment: 'center' }),
        ],
        [
          {},
          {},
          { text: yesNo(flags.production.value), alignment: 'center' },
          { text: yesNo(flags.packing.value), alignment: 'center' },
          { text: yesNo(flags.cartoning.value), alignment: 'center' },
        ],
      ],
    },
    layout: gridLayout,
  }
  return [
    { text: COMPANY.name.toUpperCase(), bold: true, fontSize: 13, alignment: 'center' },
    { text: 'DAILY REPORT', bold: true, fontSize: 11, alignment: 'center', margin: [0, 1, 0, 2] },
    {
      text: `SAP data as of ${payload.dataAsOf ? dayLabel(payload.dataAsOf) : '—'} · outwards: ${basisLabel(payload.basis)} · generated ${new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(payload.generatedAt))} IST`,
      fontSize: 7,
      color: GREY,
      alignment: 'center',
      margin: [0, 0, 0, 6],
    },
    flagTable,
  ]
}

function manpowerBlock(payload: DailyReportPayload): Content[] {
  const values = payload.manpower.values
  const cells = MANPOWER_KEYS.map((key): TableCell => ({ text: values ? count.format(values[key] ?? 0) : '—', alignment: 'center' }))
  const table: Content = {
    margin: [0, 6, 0, 0],
    table: {
      widths: [...MANPOWER_KEYS.map(() => '*' as const), 46],
      body: [
        sectionTitle('Manpower', MANPOWER_KEYS.length + 1),
        [...MANPOWER_KEYS.map((key) => head(MANPOWER_LABELS[key], { alignment: 'center', fontSize: 7 })), head('Total', { alignment: 'center', fontSize: 7 })],
        [...cells, { text: payload.manpower.total != null ? count.format(payload.manpower.total) : '—', bold: true, alignment: 'center' }],
      ],
    },
    layout: gridLayout,
  }
  if (values) return [table]
  return [table, { text: 'Manpower not entered — reply “manpower …” on WhatsApp, or enter it on the Reports page, to add it.', italics: true, color: '#b26a00', fontSize: 7, margin: [0, 2, 0, 0] }]
}

function bankBlock(payload: DailyReportPayload): Content {
  const banks = payload.banks
  const fill = (index: number) => (banks[index]?.houseBank ? HOUSE_FILL : undefined)
  const side = 2 + Math.max(1, banks.length)
  const columns = side * 2 + 1
  const empty = (): TableCell => ({ text: '' })
  const gutter = (): TableCell => ({ text: '', border: [true, false, true, false] } as TableCell)

  const bankHeads = (): TableCell[] => banks.map((bank, index) => head(bank.bank, { alignment: 'right', fillColor: fill(index) ?? HEAD_FILL }))
  const valueCells = (values: Array<number | null>, bold = false): TableCell[] =>
    values.map((value, index) => ({ text: amount(value), alignment: 'right', bold, fillColor: fill(index) }) as TableCell)

  const rows: TableCell[][] = []
  // bank position: opening on the left, closing on the right
  rows.push([...sectionTitle('Bank position', columns)])
  rows.push([head('', { colSpan: 2 }), {}, ...bankHeads(), gutter(), head('', { colSpan: 2 }), {}, ...bankHeads()])
  rows.push([
    { text: 'Bank opening balance', bold: true, colSpan: 2 },
    {},
    ...valueCells(banks.map((bank) => bank.opening), true),
    gutter(),
    { text: 'Bank closing balance', bold: true, colSpan: 2 },
    {},
    ...valueCells(banks.map((bank) => bank.closing), true),
  ])
  rows.push([
    { text: 'Bank receipts', bold: true, colSpan: side, alignment: 'center', fillColor: HEAD_FILL },
    ...Array.from({ length: side - 1 }, empty),
    gutter(),
    { text: 'Bank payments', bold: true, colSpan: side, alignment: 'center', fillColor: HEAD_FILL },
    ...Array.from({ length: side - 1 }, empty),
  ])
  rows.push([head('Sl. No', { alignment: 'center' }), head('Party name'), ...bankHeads(), gutter(), head('Sl. No', { alignment: 'center' }), head('Transaction'), ...bankHeads()])

  const lineCells = (line: ReportLine | undefined, index: number, which: 'in' | 'out'): TableCell[] => [
    { text: line ? String(index + 1) : '', alignment: 'center' },
    { text: line ? `${printable(line, which)}${line.movedFrom ? ' *' : ''}` : '' },
    ...banks.map((bank, b) => ({ text: line && line.bank === bank.bank ? amount(line.amount) : '', alignment: 'right', fillColor: fill(b) }) as TableCell),
  ]
  const lineRows = Math.max(MIN_LINE_ROWS, payload.receipts.length, payload.payments.length)
  for (let i = 0; i < lineRows; i += 1) {
    rows.push([...lineCells(payload.receipts[i], i, 'in'), gutter(), ...lineCells(payload.payments[i], i, 'out')])
  }
  rows.push([
    { text: 'Total', bold: true, colSpan: 2, alignment: 'right' },
    {},
    ...valueCells(banks.map((bank) => bank.receipts), true),
    gutter(),
    { text: 'Total', bold: true, colSpan: 2, alignment: 'right' },
    {},
    ...valueCells(banks.map((bank) => bank.payments), true),
  ])
  return {
    margin: [0, 6, 0, 0],
    table: {
      headerRows: 0,
      widths: [24, '*', ...banks.map(() => 54), 6, 24, '*', ...banks.map(() => 54)],
      body: rows,
    },
    layout: gridLayout,
  }
}

function materialBlock(payload: DailyReportPayload): Content {
  const inwards = payload.inwards
  const outwards = payload.outwards.rows
  const rows: TableCell[][] = []
  const gutter = (): TableCell => ({ text: '', border: [true, false, true, false] } as TableCell)
  rows.push([
    { text: 'Material inwards', bold: true, colSpan: 4, alignment: 'center', fillColor: HEAD_FILL },
    {},
    {},
    {},
    gutter(),
    { text: 'Material outwards', bold: true, colSpan: 3, alignment: 'center', fillColor: HEAD_FILL },
    {},
    {},
  ])
  rows.push([
    head('Sl. No', { alignment: 'center' }),
    head('Item'),
    head('Quantity'),
    head('Remarks'),
    gutter(),
    head('Sl. No', { alignment: 'center' }),
    head('Party name'),
    head('Value', { alignment: 'right' }),
  ])
  const n = Math.max(inwards.length, outwards.length)
  for (let i = 0; i < n; i += 1) {
    const inward = inwards[i]
    const out = outwards[i]
    rows.push([
      { text: inward ? String(i + 1) : '', alignment: 'center' },
      { text: inward?.label ?? '' },
      { text: inward?.quantity ?? '' },
      { text: inward?.remarks ?? '', fontSize: 7 },
      gutter(),
      { text: out ? String(i + 1) : '', alignment: 'center' },
      { text: out?.label ?? '' },
      { text: out ? amount(out.amount) : '', alignment: 'right' },
    ])
  }
  const blankLeft = (): TableCell[] => [{ text: '', colSpan: 4, border: [false, true, false, false] } as TableCell, {}, {}, {}]
  rows.push([
    ...blankLeft(),
    { text: '', border: [false, false, false, false] } as TableCell,
    { text: 'Total invoice amount', bold: true, colSpan: 2 },
    {},
    { text: amount(payload.outwards.total), bold: true, alignment: 'right' },
  ])
  rows.push([
    { text: '', colSpan: 4, border: [false, false, false, false] } as TableCell,
    {},
    {},
    {},
    { text: '', border: [false, false, false, false] } as TableCell,
    { text: `Monthly total (incl. GST), ${payload.outwards.monthLabel}`, bold: true, colSpan: 2 },
    {},
    { text: payload.outwards.monthToDate != null ? amount(payload.outwards.monthToDate) : '—', bold: true, alignment: 'right' },
  ])
  return {
    margin: [0, 6, 0, 0],
    table: { widths: [24, 58, 108, '*', 6, 24, '*', 70], body: rows },
    layout: gridLayout,
  }
}

function footnotes(payload: DailyReportPayload): Content[] {
  const notes: Content[] = []
  if (payload.kind === 'inputs_only') {
    notes.push({ text: payload.footnotes[0] ?? 'SAP data is not in for this day.', bold: true, color: '#b26a00', margin: [0, 8, 0, 0] })
  }
  if (payload.notes) notes.push({ text: `Notes: ${payload.notes}`, margin: [0, 6, 0, 0] })
  const lines = payload.kind === 'inputs_only' ? payload.footnotes.slice(1) : payload.footnotes
  notes.push({
    margin: [0, 8, 0, 0],
    fontSize: 6.5,
    color: GREY,
    stack: [
      { text: 'Notes', bold: true },
      // WhatsApp bold (*manpower …*) reads as plain text here; a single * marks a line counted on another day
      { ul: lines.map((line) => line.replace(/\*([^*\n]+)\*/g, '$1')) },
      ...(payload.knownDifferences.length
        ? [{ text: 'Known differences vs manual sheet', bold: true, margin: [0, 3, 0, 0] } as Content, { ul: [...payload.knownDifferences] } as Content]
        : []),
    ],
  })
  return notes
}

export function dailyReportDefinition(payload: DailyReportPayload): TDocumentDefinitions {
  const content: Content[] = [...titleBlock(payload), ...manpowerBlock(payload)]
  if (payload.kind === 'full') content.push(bankBlock(payload))
  content.push(materialBlock(payload), ...footnotes(payload))
  return {
    pageSize: 'A4',
    pageOrientation: 'portrait',
    pageMargins: [28, 26, 28, 26],
    info: { title: `Daily report ${ddmmyyyy(payload.reportDate)}`, author: COMPANY.name },
    defaultStyle: { fontSize: 7.5 },
    content,
  }
}

export function renderDailyReportPdf(payload: DailyReportPayload): Promise<Buffer> {
  return renderPdf(dailyReportDefinition(payload))
}

export function dailyReportFileName(payload: Pick<DailyReportPayload, 'reportDate'>): string {
  return `daily-report-${payload.reportDate}.pdf`
}

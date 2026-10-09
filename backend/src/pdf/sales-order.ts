import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { SalesOrder } from '../db/types'
import type { PartyAddress, PartyCard } from '../queries/tso'
import { COMPANY, amountInWords, bankLines, formatInr, renderPdf } from './kit'

/**
 * The customer copy of a Tierra sales order (po-flow.md §8), the only document that ever goes to a customer group:
 * letterhead, a status stamp, the order and PO references, bill-to / ship-to from SAP, the lines with SAP's HSN,
 * the GST split, the amount in words and the buyer's notes. Nothing about stock, cost or other customers.
 */

export type SoStamp =
  | { kind: 'draft' }
  | { kind: 'pending' }
  | { kind: 'approved'; by: string; at: string }

export type SalesOrderPdfInput = {
  order: SalesOrder
  customer: PartyCard | null
  /** The company that issued the PO, as printed on it ("Acme Retail Limited"). */
  buyerName: string | null
  stamp: SoStamp
  now: Date
}

const IST = 'Asia/Kolkata'
const GREY = '#5b6770'
const LINE = '#c9d1d6'

const plain = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const fine = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
const count = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 3 })

/** 2026-08-01 -> 01-08-2026 */
export function ddmmyyyy(iso: string | null): string {
  if (!iso) return '—'
  const [y, m, d] = iso.slice(0, 10).split('-')
  return `${d}-${m}-${y}`
}

export function istStamp(iso: string): string {
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
  return `${text} IST`
}

export function stampText(stamp: SoStamp): string {
  if (stamp.kind === 'draft') return 'DRAFT'
  if (stamp.kind === 'pending') return 'PENDING APPROVAL'
  return `APPROVED · ${stamp.by} · ${istStamp(stamp.at)}`
}

function stampColor(stamp: SoStamp): string {
  if (stamp.kind === 'approved') return '#1f7a3f'
  if (stamp.kind === 'pending') return '#b26a00'
  return GREY
}

function address(party: PartyCard | null, type: PartyAddress['type'], fallbackGstin: string | null): Content[] {
  const rows = party?.addresses.filter((row) => row.type === type) ?? []
  const row = rows.find((entry) => entry.isDefault) ?? rows[0]
  if (!party) return [{ text: '—' }]
  const lines = [row?.street, [row?.city, row?.zipCode].filter(Boolean).join(' '), row?.state ? `State ${row.state}` : null]
    .map((value) => value?.replace(/"/g, '').trim())
    .filter((value): value is string => Boolean(value))
  return [
    { text: row?.name || party.cardName, bold: true },
    ...lines.map((line): Content => ({ text: line })),
    { text: `GSTIN ${row?.gstin ?? fallbackGstin ?? party.gstin ?? '—'}` },
    ...(type === 'bill_to' && (party.phone || party.email)
      ? [{ text: [party.phone, party.email].filter(Boolean).join(' · '), color: GREY } as Content]
      : []),
  ]
}

function kv(rows: Array<[string, string]>): Content {
  return {
    table: {
      widths: [92, '*'],
      body: rows.map(([key, value]): TableCell[] => [
        { text: key, color: GREY },
        { text: value, bold: key.startsWith('SO No') },
      ]),
    },
    layout: 'noBorders',
  }
}

function boxed(title: string, body: Content[]): Content {
  return {
    table: {
      widths: ['*'],
      body: [[{ stack: [{ text: title, bold: true, color: GREY, fontSize: 7, margin: [0, 0, 0, 2] }, ...body] }]],
    },
    layout: { hLineColor: () => LINE, vLineColor: () => LINE, paddingLeft: () => 6, paddingRight: () => 6, paddingTop: () => 4, paddingBottom: () => 4 },
  }
}

function money(value: number): string {
  return plain.format(value)
}

export function salesOrderDefinition(input: SalesOrderPdfInput): TDocumentDefinitions {
  const { order, customer, stamp } = input
  const igst = order.taxKind === 'igst'
  const lineRows: TableCell[][] = order.lines.map((line) => [
    { text: String(line.lineNo), alignment: 'center' },
    { text: line.itemCode },
    { text: [line.articleNo, line.ean].filter(Boolean).join('\n') || '—' },
    { text: line.hsn ?? '—' },
    { text: line.description || line.itemName || line.itemCode },
    { text: 'Pcs', alignment: 'center' },
    { text: count.format(line.pcs), alignment: 'right' },
    { text: line.cartons != null ? `${count.format(line.cartons)}${line.uom ? ` ${line.uom}` : ''}` : '—', alignment: 'right' },
    { text: line.mrp != null ? money(line.mrp) : '—', alignment: 'right' },
    { text: fine.format(line.unitPrice), alignment: 'right' },
    { text: `${count.format(line.gstPct)}%`, alignment: 'right' },
    { text: money(line.amount), alignment: 'right' },
  ])
  const head = ['Sl', 'Item code', 'Article / EAN', 'HSN', 'Item', 'UoM', 'Qty', 'Boxes', 'MRP', 'Rate', 'GST', 'Amount'].map(
    (text): TableCell => ({ text, bold: true, fillColor: '#eef2f3', alignment: ['Qty', 'Boxes', 'MRP', 'Rate', 'GST', 'Amount'].includes(text) ? 'right' : 'left' }),
  )
  const totalPcs = order.lines.reduce((sum, line) => sum + line.pcs, 0)
  const totalBoxes = order.lines.every((line) => line.cartons != null)
    ? order.lines.reduce((sum, line) => sum + (line.cartons ?? 0), 0)
    : null

  // tax summary by HSN and rate; a Cess column only when the PO carries cess
  const hasCess = (order.cess ?? 0) > 0 || order.lines.some((line) => (line.cessAmount ?? 0) > 0)
  const groups = new Map<string, { hsn: string; rate: number; taxable: number; tax: number; cess: number }>()
  for (const line of order.lines) {
    const key = `${line.hsn ?? '—'}|${line.gstPct}`
    const group = groups.get(key) ?? { hsn: line.hsn ?? '—', rate: line.gstPct, taxable: 0, tax: 0, cess: 0 }
    group.taxable += line.amount
    group.tax += line.taxAmount
    group.cess += line.cessAmount ?? 0
    groups.set(key, group)
  }
  const taxHead = [
    ...(igst ? ['HSN', 'GST %', 'Taxable value', 'IGST'] : ['HSN', 'GST %', 'Taxable value', 'CGST', 'SGST']),
    ...(hasCess ? ['Cess'] : []),
    'Total tax',
  ].map((text, index): TableCell => ({ text, bold: true, fillColor: '#eef2f3', alignment: index >= 2 ? 'right' : 'left' }))
  const taxRows: TableCell[][] = [...groups.values()].map((group) => {
    const cells: TableCell[] = [
      { text: group.hsn },
      { text: `${count.format(group.rate)}%` },
      { text: money(group.taxable), alignment: 'right' },
    ]
    if (igst) cells.push({ text: money(group.tax), alignment: 'right' })
    else cells.push({ text: money(group.tax / 2), alignment: 'right' }, { text: money(group.tax / 2), alignment: 'right' })
    if (hasCess) cells.push({ text: money(group.cess), alignment: 'right' })
    cells.push({ text: money(group.tax + group.cess), alignment: 'right' })
    return cells
  })

  const totals: Array<[string, string, boolean?]> = [
    ['Taxable value', money(order.basicTotal)],
    ...(igst
      ? [['IGST', money(order.igst)] as [string, string]]
      : [
          ['CGST', money(order.cgst)] as [string, string],
          ['SGST', money(order.sgst)] as [string, string],
        ]),
    ...(hasCess ? [['Cess', money(order.cess ?? 0)] as [string, string]] : []),
    ['Round off', money(0)],
    ['Net value', formatInr(order.total), true],
  ]
  const bank = bankLines()

  const content: Content[] = [
    {
      columns: [
        {
          width: '*',
          stack: [
            { text: COMPANY.name, bold: true, fontSize: 13 },
            { text: COMPANY.address.join(', '), fontSize: 8 },
            { text: `${COMPANY.website} · ${COMPANY.email}`, fontSize: 8 },
            { text: `FSSAI ${COMPANY.fssai} · CIN ${COMPANY.cin}`, fontSize: 8 },
          ],
        },
        {
          width: 150,
          stack: [
            { text: `GSTIN ${COMPANY.gstin}`, fontSize: 8, alignment: 'right' },
            { text: `PAN ${COMPANY.pan}`, fontSize: 8, alignment: 'right' },
            { text: `State code ${COMPANY.stateCode} (Kerala)`, fontSize: 8, alignment: 'right' },
          ],
        },
      ],
    },
    { canvas: [{ type: 'line', x1: 0, y1: 4, x2: 535, y2: 4, lineWidth: 0.75 }], margin: [0, 0, 0, 6] },
    {
      columns: [
        { text: 'SALES ORDER', bold: true, fontSize: 15, width: '*' },
        {
          width: 'auto',
          table: { body: [[{ text: stampText(stamp), bold: true, color: stampColor(stamp), fontSize: 9, margin: [4, 1, 4, 1] }]] },
          layout: { hLineColor: () => stampColor(stamp), vLineColor: () => stampColor(stamp) },
        },
      ],
      margin: [0, 0, 0, 6],
    },
    {
      columns: [
        kv([
          ['SO No', `${order.docNo}${order.version > 1 ? ` (v${order.version})` : ''}`],
          ['SO date', ddmmyyyy(order.docDate)],
          ['Customer PO No', order.customerPoNo ?? '—'],
          ['PO date', ddmmyyyy(order.poDate)],
          ['Delivery date', ddmmyyyy(order.deliveryDate)],
          ['Delivery term', order.deliveryTerm ?? '—'],
          ['Payment terms', order.paymentTerms ?? 'As agreed'],
        ]),
        kv([
          ['Buyer', input.buyerName ?? customer?.cardName ?? '—'],
          ['Place of supply', order.placeOfSupply ? `${order.placeOfSupply} (${order.stateCode})` : (order.stateCode ?? '—')],
          ['Our vendor code', order.vendorCode ?? '—'],
          ['Site', order.siteCode ?? '—'],
          ['Customer code', order.cardCode],
        ]),
      ],
      columnGap: 12,
      fontSize: 8,
    },
    {
      columns: [boxed('BILL TO', address(customer, 'bill_to', null)), boxed('SHIP TO', address(customer, 'ship_to', order.shipToGstin))],
      columnGap: 8,
      fontSize: 8,
      margin: [0, 6, 0, 6],
    },
    {
      table: {
        headerRows: 1,
        widths: [10, 46, 56, 36, '*', 18, 28, 34, 30, 36, 20, 46],
        body: [
          head,
          ...lineRows,
          [
            { text: 'Total', bold: true, colSpan: 6 },
            {}, {}, {}, {}, {},
            { text: count.format(totalPcs), bold: true, alignment: 'right' },
            { text: totalBoxes != null ? count.format(totalBoxes) : '', bold: true, alignment: 'right' },
            { text: '' },
            { text: '' },
            { text: '' },
            { text: money(order.basicTotal), bold: true, alignment: 'right' },
          ],
        ],
      },
      layout: { hLineColor: () => LINE, vLineColor: () => LINE, paddingLeft: () => 2, paddingRight: () => 2 },
      fontSize: 7.5,
    },
    {
      columns: [
        {
          width: '*',
          stack: [
            {
              table: {
                headerRows: 1,
                widths: [
                  ...(igst ? [50, 32, '*', 60] : [46, 30, '*', 50, 50]),
                  ...(hasCess ? [44] : []),
                  igst ? 60 : 54,
                ],
                body: [taxHead, ...taxRows],
              },
              layout: { hLineColor: () => LINE, vLineColor: () => LINE },
              fontSize: 7.5,
            },
            { text: amountInWords(order.total), italics: true, bold: true, fontSize: 8.5, margin: [0, 6, 0, 0] },
          ],
        },
        {
          width: 170,
          table: {
            widths: ['*', 'auto'],
            body: totals.map(([label, value, strong]): TableCell[] => [
              { text: label, bold: Boolean(strong) },
              { text: value, alignment: 'right', bold: Boolean(strong) },
            ]),
          },
          layout: 'lightHorizontalLines',
          fontSize: 8.5,
        },
      ],
      columnGap: 12,
      margin: [0, 8, 0, 0],
    },
  ]
  if (bank.length) {
    content.push({
      stack: [{ text: 'Bank details', bold: true, color: GREY }, ...bank.map((line): Content => ({ text: line }))],
      fontSize: 8,
      margin: [0, 8, 0, 0],
    })
  }
  if (order.notes.length) {
    content.push({
      stack: [
        { text: "Buyer's instructions (from the PO)", bold: true, color: GREY },
        { ul: order.notes.map((note) => note), fontSize: 6.5 },
      ],
      fontSize: 8,
      margin: [0, 8, 0, 0],
    })
  }
  content.push(
    {
      text:
        'Declaration: the goods are manufactured and packed under FSSAI licence ' +
        `${COMPANY.fssai} and conform to the Food Safety and Standards Act, 2006 and its regulations. ` +
        'This order shows the actual price of the goods described; all particulars are true and correct.',
      fontSize: 6.5,
      color: GREY,
      margin: [0, 8, 0, 0],
    },
    {
      columns: ['Prepared by', 'Checked by', `For ${COMPANY.name}\nAuthorised signatory`].map((label): Content => ({
        text: label,
        fontSize: 8,
        alignment: 'center',
        margin: [0, 20, 0, 0],
      })),
    },
  )

  return {
    pageSize: 'A4',
    pageMargins: [30, 28, 30, 36],
    info: { title: `Sales order ${order.docNo}`, author: COMPANY.name },
    footer: (page, pages) => ({
      text: `${order.docNo} · v${order.version} · page ${page} of ${pages}`,
      fontSize: 7,
      color: GREY,
      alignment: 'center',
    }),
    content,
    defaultStyle: { fontSize: 8.5 },
  }
}

export function renderSalesOrderPdf(input: SalesOrderPdfInput): Promise<Buffer> {
  return renderPdf(salesOrderDefinition(input))
}

/** TSO/26-27/0001, v1, approved -> TSO-26-27-0001-v1-approved.pdf */
export function salesOrderFileName(docNo: string, version: number, kind: 'pending' | 'approved' | 'draft' | 'annex'): string {
  return `${docNo.replace(/\//g, '-')}-v${version}${kind === 'pending' ? '' : `-${kind}`}.pdf`
}

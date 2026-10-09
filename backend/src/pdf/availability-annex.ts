import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces'
import type { CustomerPo, InventoryCheck, InventoryCheckLine, ProcurementRequest, SalesOrder, TaskRecord } from '../db/types'
import { COMPANY, formatInr, renderPdf } from './kit'
import { ddmmyyyy, istStamp } from './sales-order'

/**
 * The internal annex of a sales order: the availability check behind it, warnings (PO HSN ≠ SAP HSN, repeat PO,
 * self-raised), the procurement requests and the tasks. It goes to the admin with the approval request and never to
 * a customer group.
 */

export type AnnexInput = {
  order: SalesOrder
  po: CustomerPo | null
  check: InventoryCheck | null
  customerName: string | null
  warnings: string[]
  requests: ProcurementRequest[]
  tasks: TaskRecord[]
  now: Date
}

const GREY = '#5b6770'
const LINE = '#c9d1d6'
const qty = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })
const fine = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 4 })

const VERDICT: Record<string, string> = { pass: 'PASS', pass_with_incoming: 'PASS WITH INCOMING', fail: 'FAIL' }
const STATUS: Record<string, string> = { ok: 'OK', short_now: 'short now, on order', short: 'SHORT' }

function n(value: number | null | undefined): string {
  if (value == null) return '—'
  const format = value !== 0 && Math.abs(value) < 0.01 ? fine : qty
  return format.format(value).replace(/^-/, '−')
}

function header(labels: string[], right: number): TableCell[] {
  return labels.map((text, index): TableCell => ({ text, bold: true, fillColor: '#eef2f3', alignment: index >= right ? 'right' : 'left' }))
}

function ownerLabel(line: InventoryCheckLine): string {
  if (line.owner === 'customer') return line.ownerName ?? line.ownerCardCode ?? 'customer'
  if (line.owner === 'customer_unknown') return 'customer (unknown)'
  return 'Tierra'
}

export function annexDefinition(input: AnnexInput): TDocumentDefinitions {
  const { order, check } = input
  const fg = check?.lines.filter((line) => line.kind === 'fg') ?? []
  const components = check?.lines.filter((line) => line.kind === 'component') ?? []
  const content: Content[] = [
    { text: `${COMPANY.name} — INTERNAL`, fontSize: 8, color: GREY },
    { text: `Availability annex · ${order.docNo}`, bold: true, fontSize: 14, margin: [0, 2, 0, 2] },
    {
      text: 'Internal only. Never sent to the customer or a customer group.',
      color: '#b42318',
      bold: true,
      fontSize: 8,
      margin: [0, 0, 0, 6],
    },
    {
      columns: [
        {
          stack: [
            `Customer: ${input.customerName ?? order.cardCode} (${order.cardCode})`,
            `PO ${order.customerPoNo ?? '—'} of ${ddmmyyyy(order.poDate)} · delivery ${ddmmyyyy(order.deliveryDate)}`,
            `Order value ${formatInr(order.total)} (taxable ${formatInr(order.basicTotal)})`,
          ],
        },
        {
          stack: [
            { text: `Verdict: ${check ? VERDICT[check.verdict] : '—'}`, bold: true },
            `SAP data as of ${check?.dataAsOf ? ddmmyyyy(check.dataAsOf) : '—'}`,
            `Printed ${istStamp(input.now.toISOString())}`,
          ],
          alignment: 'right',
        },
      ],
      fontSize: 8.5,
      margin: [0, 0, 0, 8],
    },
  ]

  if (fg.length) {
    content.push(
      { text: 'Finished goods', bold: true, margin: [0, 0, 0, 2] },
      {
        table: {
          headerRows: 1,
          widths: [70, '*', 50, 50, 50, 50, 50],
          body: [
            header(['Item', 'Name', 'Pcs', 'Free', 'Reserved', 'From stock', 'To make'], 2),
            ...fg.map((line): TableCell[] => [
              line.itemCode,
              line.itemName ?? '',
              { text: n(line.need), alignment: 'right' },
              { text: n(line.free), alignment: 'right' },
              { text: n(line.reserved), alignment: 'right' },
              { text: n(line.fromStock), alignment: 'right' },
              { text: n(line.toMake), alignment: 'right', bold: (line.toMake ?? 0) > 0 },
            ]),
          ],
        },
        layout: { hLineColor: () => LINE, vLineColor: () => LINE },
        fontSize: 7.5,
        margin: [0, 0, 0, 8],
      },
    )
  }

  if (components.length) {
    content.push(
      { text: 'Materials (BOM explosion of what has to be made)', bold: true, margin: [0, 0, 0, 2] },
      {
        table: {
          headerRows: 1,
          widths: [44, 62, 38, 22, 38, 38, 32, 40, 38, 38, 48, '*'],
          body: [
            header(['Role', 'Item', 'Need', 'UoM', 'Free', 'Reserved', 'Received', 'On order', 'Short now', 'Short after', 'Owner', 'Status'], 2),
            ...components.map((line): TableCell[] => {
              const flagged = line.checked && line.status !== 'ok'
              return [
                { text: `${line.role ?? ''}${line.checked ? '' : ' (warn)'}` },
                { text: `${line.itemCode}${line.estimated ? ' *' : ''}` },
                { text: n(line.need), alignment: 'right' },
                { text: line.uom ?? '' },
                { text: n(line.free), alignment: 'right' },
                { text: n(line.reserved), alignment: 'right' },
                { text: n(line.adjustments), alignment: 'right' },
                { text: n(line.onOrder), alignment: 'right' },
                { text: n(line.shortNow), alignment: 'right', bold: line.shortNow > 0 },
                { text: n(line.shortAfterIncoming), alignment: 'right', bold: line.shortAfterIncoming > 0 },
                { text: ownerLabel(line) },
                { text: `${STATUS[line.status] ?? line.status}${line.incoming.length ? ` (${line.incoming.slice(0, 2).join(', ')})` : ''}`, color: flagged ? '#b42318' : undefined },
              ]
            }),
          ],
        },
        layout: { hLineColor: () => LINE, vLineColor: () => LINE },
        fontSize: 7,
        margin: [0, 0, 0, 2],
      },
      { text: '* estimated (placeholder BOM line or 90-day actual use). (warn) = warning only, never decides the verdict.', fontSize: 7, color: GREY, margin: [0, 0, 0, 8] },
    )
  }

  const warnings = [...input.warnings, ...(check?.warnings ?? [])]
  if (warnings.length) {
    content.push({ text: 'Warnings', bold: true, margin: [0, 0, 0, 2] }, { ul: warnings, fontSize: 8, margin: [0, 0, 0, 8] })
  }

  if (input.requests.length) {
    content.push(
      { text: 'Procurement requests', bold: true, margin: [0, 0, 0, 2] },
      {
        table: {
          headerRows: 1,
          widths: [70, '*', 60, 30, 60, 40],
          body: [
            header(['Item', 'Name', 'Qty', 'UoM', 'Reason', 'Status'], 2),
            ...input.requests.map((row): TableCell[] => [
              row.itemCode,
              row.itemName ?? '',
              { text: n(row.qty), alignment: 'right' },
              row.uom ?? '',
              row.reason,
              row.status,
            ]),
          ],
        },
        layout: { hLineColor: () => LINE, vLineColor: () => LINE },
        fontSize: 7.5,
        margin: [0, 0, 0, 8],
      },
    )
  }

  if (input.tasks.length) {
    content.push(
      { text: 'Tasks', bold: true, margin: [0, 0, 0, 2] },
      {
        ul: input.tasks.map((task) => `${task.title} — ${task.assigneeName ?? task.assigneeRole ?? 'unassigned'} (${task.status})`),
        fontSize: 8,
      },
    )
  }

  return {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 24, 28, 30],
    info: { title: `Availability annex ${order.docNo}`, author: COMPANY.name },
    footer: (page, pages) => ({
      text: `${order.docNo} · internal annex · page ${page} of ${pages}`,
      fontSize: 7,
      color: GREY,
      alignment: 'center',
    }),
    content,
    defaultStyle: { fontSize: 8.5 },
  }
}

export function renderAnnexPdf(input: AnnexInput): Promise<Buffer> {
  return renderPdf(annexDefinition(input))
}

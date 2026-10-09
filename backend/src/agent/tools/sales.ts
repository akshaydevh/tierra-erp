import { z } from 'zod/v4'
import { dispatchDay } from '../../queries/dispatch'
import {
  ORDER_STATES,
  customerPoStatus,
  findCreditNotes,
  findInvoices,
  findSalesOrders,
  invoiceByNo,
  salesOrderByNo,
  type InvoiceListRow,
  type SalesOrderRow,
} from '../../queries/sales'
import { docKey, filesForDocuments } from '../../queries/documents'
import { fileForModel } from '../files'
import { normalizeDocNo } from '../refs'
import { defineTool, docNoArg, isoDay, noteDocument, notFound, recordAccess, type ToolContext } from './types'

// Party-safe: every read here passes ctx.cards, so a customer group only ever sees its own cards.

function orderSummary(row: SalesOrderRow) {
  return {
    docNo: row.docNo,
    docDate: row.docDate,
    customer: row.cardName,
    cardCode: row.cardCode,
    customerPoNo: row.customerPoNo,
    status: row.status,
    total: row.total,
    lines: row.lineCount,
    qty: row.totalQty,
    invoices: row.invoiceCount,
  }
}

function invoiceSummary(row: InvoiceListRow) {
  return {
    docNo: row.docNo,
    docDate: row.docDate,
    customer: row.cardName,
    cardCode: row.cardCode,
    customerPoNo: row.customerPoNo,
    total: row.total,
    salesOrders: row.soDocNos,
    ewayBill: row.ewbNo ? `${row.ewbNo}${row.ewbCancelled ? ' (cancelled)' : ''}` : null,
    eInvoice: row.irnStatus,
  }
}

/** Which files SAP has for each listed invoice (roles), so a list can offer them. */
async function fileRoles(ctx: ToolContext, docEntries: number[]): Promise<Map<number, string[]>> {
  const found = await filesForDocuments(
    ctx.deps.sapSql,
    ctx.cards,
    docEntries.map((docEntry) => ({ sapObject: '13', docEntry })),
    recordAccess(ctx),
  )
  return new Map(docEntries.map((entry) => [entry, [...new Set((found.get(docKey({ sapObject: '13', docEntry: entry })) ?? []).map((file) => file.role))]]))
}

function docNo(ctx: ToolContext, raw: string): string {
  return normalizeDocNo(raw, ctx.referenceDay) ?? raw.trim().toUpperCase()
}

export const salesTools = [
  defineTool({
    name: 'find_sales_orders',
    description:
      'Search SAP sales orders (newest first, top 10 plus the total count). Filter by text (number, customer, customer PO), status, customer PO number, item code or order date.',
    scope: 'party',
    args: z.object({
      query: z.string().optional().describe('Text in the SO number, customer name or customer PO number'),
      status: z.enum(ORDER_STATES).optional(),
      customer_po_no: z.string().optional(),
      item_code: z.string().optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    async run(ctx, args) {
      const found = await findSalesOrders(ctx.deps.sapSql, ctx.cards, {
        q: args.query,
        state: args.status,
        customerPoNo: args.customer_po_no,
        itemCode: args.item_code,
        from: args.from,
        to: args.to,
      })
      return { total: found.total, totalValue: found.value, rows: found.rows.map(orderSummary) }
    },
  }),
  defineTool({
    name: 'get_sales_order',
    description: 'One SAP sales order by number: header, lines, the invoices raised against it and (internal) its approval trail.',
    scope: 'party',
    args: z.object({ doc_no: docNoArg }),
    async run(ctx, args) {
      const number = docNo(ctx, args.doc_no)
      const view = await salesOrderByNo(ctx.deps.sapSql, ctx.cards, number)
      if (!view) return notFound(ctx, `Sales order ${number}`)
      return {
        found: true,
        order: {
          ...orderSummary(view.order),
          poDate: view.order.poDate,
          dueDate: view.order.dueDate,
          taxTotal: view.order.taxTotal,
          createdBy: ctx.audience.kind === 'internal' ? view.order.createdBy : undefined,
          approvalStatus: ctx.audience.kind === 'internal' ? view.order.approvalStatus : undefined,
        },
        lineTotals: view.lineTotals,
        lines: view.lines.map((line) => ({
          itemCode: line.itemCode,
          itemName: line.itemName,
          qty: line.qty,
          openQty: line.openQty,
          price: line.price,
          lineTotal: line.lineTotal,
          taxPct: line.taxPct,
        })),
        invoices: view.invoices.map((row) => ({ docNo: row.docNo, docDate: row.docDate, total: row.total })),
        approvals:
          ctx.audience.kind === 'internal'
            ? view.approvals.map((row) => ({
                status: row.status,
                requestedBy: row.originator,
                approver: row.approver,
                requestedAt: row.requestedAt,
                decidedAt: row.decidedAt,
              }))
            : undefined,
      }
    },
  }),
  defineTool({
    name: 'customer_po_status',
    description:
      "Status of a customer's purchase order number (e.g. a 10-digit retail chain PO): the sales orders raised for it with ordered and open quantity, the invoices against them, and totals over all of them.",
    scope: 'party',
    args: z.object({ customer_po_no: z.string().min(1) }),
    async run(ctx, args) {
      const status = await customerPoStatus(ctx.deps.sapSql, ctx.cards, args.customer_po_no.trim())
      if (status.salesOrders.length === 0 && status.invoices.length === 0) {
        return notFound(ctx, `Customer PO ${args.customer_po_no}`)
      }
      return { found: true, ...status, invoices: status.invoices.map(invoiceSummary) }
    },
  }),
  defineTool({
    name: 'find_invoices',
    description:
      'Search SAP A/R (sales) invoices, cancelled ones left out (newest first, top 10, the total count and total value). Filter by text, customer PO number, item code or invoice date.',
    scope: 'party',
    args: z.object({
      query: z.string().optional().describe('Text in the invoice number, customer name or customer PO number'),
      customer_po_no: z.string().optional(),
      item_code: z.string().optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    async run(ctx, args) {
      const found = await findInvoices(ctx.deps.sapSql, ctx.cards, {
        q: args.query,
        customerPoNo: args.customer_po_no,
        itemCode: args.item_code,
        from: args.from,
        to: args.to,
      })
      const roles = await fileRoles(ctx, found.rows.slice(0, 10).map((row) => row.docEntry))
      return {
        total: found.total,
        totalValue: found.value,
        rows: found.rows.map((row) => ({ ...invoiceSummary(row), files: roles.get(row.docEntry) })),
      }
    },
  }),
  defineTool({
    name: 'get_invoice',
    description: 'One SAP A/R invoice by number (e.g. TF/26-27/447): header, lines, sales orders, e-way bill and e-invoice status, and the files SAP has for it (file_links).',
    scope: 'party',
    args: z.object({ doc_no: docNoArg }),
    async run(ctx, args) {
      const number = docNo(ctx, args.doc_no)
      const view = await invoiceByNo(ctx.deps.sapSql, ctx.cards, number)
      if (!view) return notFound(ctx, `Invoice ${number}`)
      const key = { sapObject: '13', docEntry: view.invoice.docEntry }
      noteDocument(ctx, { ...key, docNo: view.invoice.docNo })
      const files = (await filesForDocuments(ctx.deps.sapSql, ctx.cards, [key], recordAccess(ctx))).get(docKey(key)) ?? []
      return {
        found: true,
        file_links: files.map(fileForModel),
        invoice: {
          ...invoiceSummary(view.invoice),
          createdAt: view.invoice.createdAt,
          taxTotal: view.invoice.taxTotal,
          cancelled: view.invoice.cancelled,
          ewayBillAt: view.invoice.ewbAt,
          ewayBillValidTill: view.invoice.ewbValidTill,
          ackNo: view.invoice.ackNo,
        },
        lines: view.lines,
      }
    },
  }),
  defineTool({
    name: 'dispatches_on',
    description: 'Invoices (dispatches) dated on one day, with e-way bill and e-invoice status, and the day totals.',
    scope: 'party',
    args: z.object({ date: isoDay }),
    async run(ctx, args) {
      const dispatched = await dispatchDay(ctx.deps.sapSql, args.date, ctx.cards)
      return {
        date: dispatched.date,
        invoices: dispatched.kpis.invoices,
        value: dispatched.kpis.value,
        ewayBills: dispatched.kpis.ewaybills,
        eInvoiceFailures: dispatched.kpis.irnFailures,
        rows: dispatched.rows.map((row) => ({
          docNo: row.docNo,
          customer: row.cardName,
          customerPoNo: row.customerPoNo,
          total: row.total,
          raisedAt: row.createdAt,
          ewayBill: row.ewbNo,
          eInvoice: row.irnStatus,
        })),
      }
    },
  }),
  defineTool({
    name: 'find_credit_notes',
    description: 'Search SAP credit notes issued to customers (newest first, top 10 and the total count).',
    scope: 'party',
    args: z.object({ query: z.string().optional(), from: isoDay.optional(), to: isoDay.optional() }),
    async run(ctx, args) {
      const found = await findCreditNotes(ctx.deps.sapSql, ctx.cards, { q: args.query, from: args.from, to: args.to })
      return {
        total: found.total,
        totalValue: found.value,
        rows: found.rows.map((row) => ({
          docNo: row.docNo,
          docDate: row.docDate,
          customer: row.cardName,
          total: row.total,
          customerRef: row.customerRef,
          againstInvoices: row.baseInvoiceDocNos,
        })),
      }
    },
  }),
]

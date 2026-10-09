import { z } from 'zod/v4'
import type { SalesOrder } from '../../db/types'
import { salesOrderView } from '../../workflows/po-to-so'
import { defineTool, type ToolContext } from './types'

/** Tierra sales orders (TSO/26-27/0001) for the admin's questions while an approval is pinned, and procurement. */

async function findOrder(
  ctx: ToolContext,
  args: { doc_no?: string; sales_order_id?: string; po_no?: string },
): Promise<SalesOrder | null> {
  const store = ctx.deps.store
  if (args.sales_order_id) return store.getSalesOrder(args.sales_order_id.trim())
  if (args.doc_no) {
    const raw = args.doc_no.trim().toUpperCase()
    const full = /^\d{1,5}$/.test(raw) ? null : raw
    if (full) return store.findSalesOrderByNo(full)
    return (await store.listSalesOrders({ limit: 200 })).find((order) => order.seq === Number(raw)) ?? null
  }
  if (args.po_no) {
    const pos = await store.findCustomerPosByNumber(args.po_no.trim())
    for (const po of pos) {
      const order = await store.findSalesOrderForPo(po.id)
      if (order) return order
    }
    return null
  }
  const pin = ctx.pin
  if (pin?.subjectType === 'sales_order') return store.getSalesOrder(pin.subjectId)
  if (pin?.subjectType === 'approval') {
    const approval = await store.getApproval(pin.subjectId)
    return approval?.subjectType === 'sales_order' ? store.getSalesOrder(approval.subjectId) : null
  }
  if (pin?.subjectType === 'customer_po') return store.findSalesOrderForPo(pin.subjectId)
  return null
}

const orderArgs = z.object({
  doc_no: z.string().optional().describe('The TSO number, e.g. TSO/26-27/0001 (or just 1)'),
  sales_order_id: z.string().optional(),
  po_no: z.string().optional().describe('The customer PO number the TSO was raised from'),
})

export const salesOrderTools = [
  defineTool({
    name: 'get_so',
    description:
      'A Tierra sales order (TSO/…) raised from a customer PO: status, version, customer and site, PO number and dates, delivery date and term, lines (pcs, cartons, piece price, amount, reserved from stock, to make, HSN), GST totals, approval trail, procurement requests, tasks and its PDFs. Without arguments: the sales order this chat is about.',
    scope: 'internal',
    args: orderArgs,
    async run(ctx, args) {
      const order = await findOrder(ctx, args)
      if (!order) return { found: false, message: 'No Tierra sales order found. SAP sales orders: use get_sales_order.' }
      const view = await salesOrderView(ctx.deps, order)
      return {
        found: true,
        docNo: order.docNo,
        salesOrderId: order.id,
        status: order.status,
        version: order.version,
        party: order.partyName,
        cardCode: order.cardCode,
        site: order.siteCode,
        customerPoNo: order.customerPoNo,
        customerPoId: order.customerPoId,
        poDate: order.poDate,
        soDate: order.docDate,
        deliveryDate: order.deliveryDate,
        deliveryTerm: order.deliveryTerm,
        paymentTerms: order.paymentTerms,
        vendorCode: order.vendorCode,
        placeOfSupply: order.placeOfSupply,
        lines: order.lines.map((line) => ({
          line: line.lineNo,
          item: line.itemCode,
          name: line.itemName,
          article: line.articleNo,
          pcs: line.pcs,
          cartons: line.cartons,
          buyerUnit: line.uom,
          piecePrice: line.unitPrice,
          amount: line.amount,
          gstPct: line.gstPct,
          hsn: line.hsn,
          fromStockReserved: line.reservedPcs,
          toMake: line.toMake,
        })),
        totals: { taxable: order.basicTotal, cgst: order.cgst, sgst: order.sgst, igst: order.igst, total: order.total },
        check: view.check ? { checkId: view.check.id, verdict: view.check.verdict, dataAsOf: view.check.dataAsOf } : null,
        approvals: view.approvals.map((approval) => ({
          version: approval.version,
          status: approval.status,
          via: approval.via,
          decidedBy: approval.decidedByName,
          decidedAt: approval.decidedAt,
          note: approval.note,
          selfRaised: approval.selfRaised,
        })),
        procurementRequests: view.requests.map((row) => ({ item: row.itemCode, qty: row.qty, uom: row.uom, reason: row.reason, status: row.status })),
        tasks: view.tasks.map((task) => ({ title: task.title, holder: task.assigneeName, status: task.status })),
        pdfs: view.documents.map((doc) => ({ kind: doc.kind, version: doc.version, file: doc.filename })),
        notes: order.notes,
      }
    },
  }),
  defineTool({
    name: 'send_so_pdf',
    description:
      'Send the Tierra sales order PDF (the latest customer copy) into this chat after your reply; annex: true also sends the internal availability annex. Use for "send the pdf again".',
    scope: 'internal',
    args: orderArgs.extend({ annex: z.boolean().optional() }),
    async run(ctx, args) {
      const order = await findOrder(ctx, args)
      if (!order) return { error: 'No Tierra sales order found.' }
      if (!ctx.effects.some((effect) => effect.kind === 'send_so_pdf' && effect.salesOrderId === order.id)) {
        ctx.effects.push({ kind: 'send_so_pdf', salesOrderId: order.id, annex: Boolean(args.annex) })
      }
      return { queued: true, docNo: order.docNo, version: order.version, annex: Boolean(args.annex) }
    },
  }),
  defineTool({
    name: 'procurement_requests',
    description: 'What has to be made, expedited or bought for customer orders (open by default), with the TSO or PO it is for.',
    scope: 'internal',
    args: z.object({ status: z.enum(['open', 'done', 'cancelled']).optional() }),
    async run(ctx, args) {
      const rows = await ctx.deps.store.listProcurementRequests({ status: args.status ?? 'open', limit: 100 })
      return {
        total: rows.length,
        rows: rows.map((row) => ({
          item: row.itemCode,
          name: row.itemName,
          qty: row.qty,
          uom: row.uom,
          reason: row.reason,
          status: row.status,
          for: row.subjectType === 'sales_order' ? `sales order ${row.salesOrderId}` : `customer PO ${row.customerPoId}`,
          note: row.note,
        })),
      }
    },
  }),
  defineTool({
    name: 'record_receipt',
    description:
      'Record material that has arrived but is not in SAP yet ("received 20 kg ZPMLMA"). It counts as free stock (unposted) in checks. Recorded after your reply.',
    scope: 'internal',
    args: z.object({
      lines: z
        .array(z.object({ item_code: z.string().min(3), qty: z.number().positive(), unit: z.string().optional() }))
        .min(1)
        .max(20),
    }),
    async run(ctx, args) {
      if (ctx.audience.kind !== 'internal') return { error: 'Only Tierra accounts can record receipts.' }
      const lines = args.lines.map((line) => ({ qty: line.qty, unit: line.unit?.toLowerCase() ?? null, itemCode: line.item_code.trim().toUpperCase() }))
      ctx.effects.push({ kind: 'record_receipt', lines })
      return { queued: true, lines }
    },
  }),
]

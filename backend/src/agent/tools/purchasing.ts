import { z } from 'zod/v4'
import { apInvoices, goodsReceipts, purchaseOrders } from '../../queries/purchasing'
import { defineTool, isoDay } from './types'

const search = z.object({
  query: z.string().optional().describe('Text in the number, supplier, supplier reference or item'),
  from: isoDay.optional(),
  to: isoDay.optional(),
})

export const purchasingTools = [
  defineTool({
    name: 'find_purchase_orders',
    description: 'Search SAP purchase orders to suppliers (newest first, top 10 and the total count) with what is still open.',
    scope: 'internal',
    args: search.extend({ status: z.enum(['open', 'closed', 'cancelled']).optional() }),
    async run(ctx, args) {
      const found = await purchaseOrders(ctx.deps.sapSql, { q: args.query, status: args.status, from: args.from, to: args.to, pageSize: 10 })
      return { total: found.total, rows: found.rows.map(({ docEntry: _entry, ...row }) => row) }
    },
  }),
  defineTool({
    name: 'find_grns',
    description: 'Search SAP goods receipts (GRN/GRPO), newest first (top 10 and the total count). free issue = material the customer supplied.',
    scope: 'internal',
    args: search,
    async run(ctx, args) {
      const found = await goodsReceipts(ctx.deps.sapSql, { q: args.query, from: args.from, to: args.to, pageSize: 10 })
      return { total: found.total, rows: found.rows.map(({ docEntry: _entry, ...row }) => row) }
    },
  }),
  defineTool({
    name: 'find_ap_invoices',
    description: 'Search SAP A/P (supplier) invoices, newest first (top 10 and the total count).',
    scope: 'internal',
    args: search,
    async run(ctx, args) {
      const found = await apInvoices(ctx.deps.sapSql, { q: args.query, from: args.from, to: args.to, pageSize: 10 })
      return { total: found.total, rows: found.rows.map(({ docEntry: _entry, ...row }) => row) }
    },
  }),
]

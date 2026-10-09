import { z } from 'zod/v4'
import { PRODUCTION_STATUSES, consumptionVsBom, productionOrders, withoutComponentValues } from '../../queries/production'
import { normalizeDocNo } from '../refs'
import { defineTool, docNoArg, isoDay, notFound, recordAccess } from './types'

export const productionTools = [
  defineTool({
    name: 'find_production_orders',
    description:
      'Search SAP production orders (PR/yy-yy/n), newest first (top 10 and the total count). Filter by text (number, item, customer), status or posting date. Quantities only; ₹ values are in production_cost (manager and admin).',
    scope: 'internal',
    args: z.object({
      query: z.string().optional(),
      status: z.enum(PRODUCTION_STATUSES).optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    async run(ctx, args) {
      const found = await productionOrders(ctx.deps.sapSql, {
        q: args.query,
        status: args.status,
        from: args.from,
        to: args.to,
        pageSize: 10,
      })
      return {
        total: found.total,
        rows: found.rows.map((row) => ({
          docNo: row.docNo,
          itemCode: row.itemCode,
          itemName: row.itemName,
          type: row.type,
          status: row.status,
          plannedQty: row.plannedQty,
          completedQty: row.completedQty,
          postDate: row.postDate,
          customer: row.customerName,
          stockType: row.stockType,
        })),
      }
    },
  }),
  defineTool({
    name: 'consumption_vs_bom',
    description:
      'What a production order consumed (goods issues) against its BOM standard for the completed quantity, per component, with the variance. The ₹ value issued is given to the manager and the admin only.',
    scope: 'internal',
    args: z.object({ doc_no: docNoArg }),
    async run(ctx, args) {
      const number = normalizeDocNo(args.doc_no, ctx.referenceDay) ?? args.doc_no.trim().toUpperCase()
      const view = await consumptionVsBom(ctx.deps.sapSql, number)
      if (!view) return notFound(ctx, `Production order ${number}`)
      return {
        found: true,
        order: {
          docNo: view.order.docNo,
          itemCode: view.order.itemCode,
          itemName: view.order.itemName,
          status: view.order.status,
          plannedQty: view.order.plannedQty,
          completedQty: view.order.completedQty,
          postDate: view.order.postDate,
          customer: view.order.customerName,
        },
        // ₹ values are costing: the manager and the admin only; everyone keeps the quantities
        components: recordAccess(ctx) === 'finance' ? view.lines : view.lines.map(withoutComponentValues),
      }
    },
  }),
]

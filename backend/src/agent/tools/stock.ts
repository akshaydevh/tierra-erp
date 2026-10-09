import { z } from 'zod/v4'
import { stockByItem } from '../../queries/inventory'
import { defineTool, type ToolContext } from './types'

const stockArgs = z.object({
  item_code: z.string().optional().describe('An exact item code, e.g. FGABC100'),
  query: z.string().optional().describe('Text in the item code or name, when the code is not known'),
})

async function stock(ctx: ToolContext, args: z.infer<typeof stockArgs>) {
  const codes = args.item_code ? [args.item_code.trim().toUpperCase()] : []
  if (codes.length === 0 && !args.query?.trim()) return { error: 'Give an item_code or a query.' }
  return stockByItem(ctx.deps.sapSql, { itemCodes: codes, q: codes.length ? null : args.query })
}

export const stockTools = [
  defineTool({
    name: 'free_stock',
    description:
      'Free stock of items: on hand, committed to open SAP sales orders, free (= on hand - committed) and on order, summed over warehouses; plus pieces reserved by Tierra sales orders (TSO), unposted receipts and free after both. Use for "how many are free / available".',
    scope: 'internal',
    args: stockArgs,
    async run(ctx, args) {
      const result = await stock(ctx, args)
      if ('error' in result) return result
      const overlays = await ctx.deps.store.stockOverlays(result.rows.map((row) => row.itemCode))
      return {
        total: result.total,
        rows: result.rows.map((row) => {
          const overlay = overlays[row.itemCode]
          return {
            itemCode: row.itemCode,
            name: row.itemName,
            uom: row.uom,
            onHand: row.onHand,
            committed: row.committed,
            free: row.free,
            onOrder: row.onOrder,
            ...(overlay
              ? {
                  reservedByTierraOrders: overlay.reserved,
                  unpostedReceipts: overlay.adjustments,
                  freeAfterReservations: Math.round((row.free - overlay.reserved + overlay.adjustments) * 10_000) / 10_000,
                }
              : {}),
          }
        }),
      }
    },
  }),
  defineTool({
    name: 'stock_for',
    description:
      'Stock of items per warehouse with ownership (customer-supplied material and its owner). Use for where stock sits or whose it is.',
    scope: 'internal',
    args: stockArgs,
    async run(ctx, args) {
      return stock(ctx, args)
    },
  }),
]

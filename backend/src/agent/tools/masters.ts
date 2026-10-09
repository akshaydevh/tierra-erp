import { z } from 'zod/v4'
import { FINANCE_ROLES } from '../../db/types'
import { bomFor, searchItems, searchParties } from '../../queries/masters'
import { defineTool, notFound } from './types'

export const masterTools = [
  defineTool({
    name: 'find_party',
    description: 'Find SAP customers and suppliers by name, card code, GSTIN or PAN (top 10). The balance is given to the manager and the admin only.',
    scope: 'internal',
    args: z.object({ query: z.string().min(1) }),
    async run(ctx, args) {
      const rows = await searchParties(ctx.deps.sapSql, args.query)
      // a party's balance is finance: the manager and the admin only
      const finance = ctx.audience.kind === 'internal' && FINANCE_ROLES.includes(ctx.audience.role)
      return {
        total: rows.length,
        rows: rows.slice(0, 10).map((row) => ({
          cardCode: row.cardCode,
          name: row.cardName,
          type: row.cardType,
          group: row.groupName,
          gstin: row.gstin,
          city: row.city,
          ...(finance ? { balance: row.balance } : {}),
          active: row.active,
        })),
      }
    },
  }),
  defineTool({
    name: 'find_item',
    description:
      'Find SAP items by code or name (top 10), e.g. "100g" or "laminate". Finished goods start FG, packing material TRPM, raw material TRRM.',
    scope: 'internal',
    args: z.object({ query: z.string().min(1) }),
    async run(ctx, args) {
      const rows = await searchItems(ctx.deps.sapSql, args.query)
      return {
        total: rows.length,
        rows: rows.slice(0, 10).map((row) => ({
          itemCode: row.itemCode,
          name: row.itemName,
          role: row.materialRole,
          uom: row.uom,
          pcsPerCarton: row.pcsPerCarton,
          packGrams: row.packGrams,
          gstRate: row.gstRate,
          hasBom: row.hasBom,
          active: row.active,
        })),
      }
    },
  }),
  defineTool({
    name: 'get_bom',
    description: 'The bill of materials of a finished good: components with quantity per basis and per piece.',
    scope: 'internal',
    args: z.object({ item_code: z.string().min(2) }),
    async run(ctx, args) {
      const bom = await bomFor(ctx.deps.sapSql, args.item_code.trim().toUpperCase())
      if (!bom) return notFound(ctx, `A bill of materials for ${args.item_code}`)
      return { found: true, itemCode: args.item_code.trim().toUpperCase(), ...bom }
    },
  }),
]

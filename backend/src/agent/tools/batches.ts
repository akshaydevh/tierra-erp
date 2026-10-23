import { z } from 'zod/v4'
import { batchCandidates, batchDetail, normalizeBatchCode, rankBatches } from '../../queries/batches'
import { isNotImported } from '../../queries/meta'
import { defineTool } from './types'

const findBatchArgs = z.object({
  batch_no: z.string().min(3).max(40).describe('The batch code as read or typed, e.g. KBCS07I26 (look-alike characters are fine)'),
  product: z
    .string()
    .max(120)
    .optional()
    .describe('Brand, product and pack size from the packet, e.g. "Kappo Banana Chips Classic Salted 65g"; picks between batches that share a code'),
  item_code: z.string().max(40).optional().describe('The item code, when already known'),
})

/** A code shared by two items (one run packed as 65g and 35g) gets both details, the product's first. */
const DETAILS = 2

export const batchTools = [
  defineTool({
    name: 'find_batch',
    description:
      'Find a batch by its code, tolerating misread characters (a packet photo, a typed code): the closest batches with how sure the match is (exact / close / possible), and for the best one the item, the day it was made, its production order, material batches used (raw banana lots and their suppliers), stock on hand by warehouse and the customers and invoices it went to. Use for any batch number or packet question.',
    scope: 'internal',
    args: findBatchArgs,
    async run(ctx, args) {
      const sql = ctx.deps.sapSql
      const itemCode = args.item_code?.trim().toUpperCase()
      try {
        let matches = itemCode ? rankBatches(args.batch_no, await batchCandidates(sql, [itemCode]), args.product) : []
        if (!matches.length) matches = rankBatches(args.batch_no, await batchCandidates(sql), args.product)
        if (!matches.length) {
          return {
            found: false,
            read: normalizeBatchCode(args.batch_no),
            message: 'No batch has that code or one close to it. Ask for a sharper photo of the code, or the code typed.',
          }
        }
        const best = matches[0]
        const sameCode = matches.filter((m) => m.distance === best.distance && normalizeBatchCode(m.batchNo) === normalizeBatchCode(best.batchNo))
        const details = await Promise.all(sameCode.slice(0, DETAILS).map((m) => batchDetail(sql, m.batchId)))
        return {
          found: true,
          read: normalizeBatchCode(args.batch_no),
          match: best.match,
          note:
            best.match === 'exact'
              ? undefined
              : `Not an exact match: the code as read is ${normalizeBatchCode(args.batch_no)}, the closest batch is ${best.batchNo}. Say so and ask the person to check the code on the packet.`,
          stockAsOf: ctx.dataAsOf,
          matches: matches.map((m) => ({
            batchNo: m.batchNo,
            itemCode: m.itemCode,
            itemName: m.itemName,
            inDate: m.inDate,
            onHand: m.onHand,
            match: m.match,
          })),
          details: details.filter(Boolean),
        }
      } catch (error) {
        if (isNotImported(error)) return { found: false, message: 'Batches are not in the ERP yet.' }
        throw error
      }
    },
  }),
]

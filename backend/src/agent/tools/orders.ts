import { z } from 'zod/v4'
import type { InventoryCheck, InventoryCheckLine } from '../../db/types'
import { BANANA_KG_PER_KG } from '../../domain/po-check'
import { itemFacts } from '../../queries/po'
import { runInventoryCheck } from '../../workflows/po-intake'
import { defineTool, type ToolContext } from './types'

/** The inventory check for the agent: a dry run ("can we make 10,000 FGABC500?") and the explanation of a check. */

function lineView(line: InventoryCheckLine) {
  return {
    item: line.itemCode,
    name: line.itemName,
    role: line.role,
    uom: line.uom,
    need: line.need,
    free: line.free,
    onOrder: line.onOrder,
    ...(line.kind === 'fg' ? { fromStock: line.fromStock, toMake: line.toMake } : {}),
    shortNow: line.shortNow,
    shortAfterIncoming: line.shortAfterIncoming,
    status: line.status,
    checked: line.checked,
    ...(line.estimated ? { estimated: true } : {}),
    ...(line.owner && line.owner !== 'tierra' ? { owner: line.ownerName ?? line.ownerCardCode ?? 'customer' } : {}),
    ...(line.incoming.length ? { incomingPos: line.incoming } : {}),
    ...(line.note ? { note: line.note } : {}),
  }
}

function checkView(check: InventoryCheck) {
  const fg = check.lines.filter((line) => line.kind === 'fg')
  const components = check.lines.filter((line) => line.kind === 'component')
  return {
    checkId: check.id,
    verdict: check.verdict,
    dataAsOf: check.dataAsOf,
    finishedGoods: fg.map(lineView),
    // short lines first, so a cut list still shows what matters
    materials: [...components].sort((a, b) => Number(b.status !== 'ok') - Number(a.status !== 'ok')).map(lineView),
    warnings: check.warnings,
  }
}

const RULES = [
  'Finished goods: free = on hand - committed (open SAP sales orders) - reserved by Tierra sales orders + unposted receipts; to make = pieces asked - free (never below 0).',
  'Materials: the BOM of each finished good (manual-issue lines only), need = to make x BOM quantity / BOM basis; cartons = to make / pieces per carton, rounded up.',
  `Placeholder BOM lines are estimated: raw banana = pack grams / 1000 x ${BANANA_KG_PER_KG} kg per piece; seasoning (and a laminate line that does not fit its unit) = the last 90 days of actual use per piece.`,
  'Short now = need - free; short after incoming = need - (free + on order from open purchase orders).',
  'Checked: laminate, carton, seasoning, raw banana/cassava, oil. Tape, LPG and printer ribbon are warnings only.',
  'Verdict: pass when nothing is short now; pass_with_incoming when the shortage is covered by open purchase orders; fail otherwise.',
]

export const orderTools = [
  defineTool({
    name: 'check_order',
    description:
      'Dry-run inventory check: can Tierra make / supply these finished goods now? Nets free finished stock, explodes the BOM of what has to be made and checks laminate, carton, seasoning, banana and oil against free stock and open purchase orders. Use for "can we make 10,000 FGABC500?". Quantities in pieces unless unit is cartons.',
    scope: 'internal',
    args: z.object({
      lines: z
        .array(
          z.object({
            item_code: z.string().min(2).describe('Finished good code, e.g. FGABC500'),
            qty: z.number().positive(),
            unit: z.enum(['pcs', 'cartons']).optional().describe('pcs (default) or cartons (pieces per carton from SAP)'),
          }),
        )
        .min(1)
        .max(20),
    }),
    async run(ctx: ToolContext, args) {
      const codes = args.lines.map((line) => line.item_code.trim().toUpperCase())
      const facts = await itemFacts(ctx.deps.sapSql, codes)
      const requested: Array<{ itemCode: string; pcs: number }> = []
      for (const [index, line] of args.lines.entries()) {
        const code = codes[index]!
        const item = facts[code]
        if (!item) return { error: `${code} is not an item in SAP. Use find_item first.` }
        if (item.role !== 'fg') return { error: `${code} is not a finished good.` }
        if (line.unit === 'cartons' && !item.pcsPerCarton) return { error: `${code} has no pieces per carton in SAP; give pieces.` }
        requested.push({ itemCode: code, pcs: line.unit === 'cartons' ? line.qty * item.pcsPerCarton! : line.qty })
      }
      const check = await runInventoryCheck(ctx.deps, requested, {
        customerPoId: null,
        kind: 'dry_run',
        createdBy: ctx.audience.kind === 'internal' ? ctx.audience.userId : null,
      })
      return { ...checkView(check), requested }
    },
  }),
  defineTool({
    name: 'explain_check',
    description:
      'The inventory check of a received customer PO (by its PO number or customer_po id) or of an earlier dry run (check_id): status, customer, lines, verdict, per-material numbers and how they were worked out. Use for "why is PO 4400012345 short?" or "explain the check".',
    scope: 'internal',
    args: z.object({
      po_no: z.string().optional().describe('The customer PO number, e.g. 4400012345'),
      customer_po_id: z.string().optional(),
      check_id: z.string().optional(),
    }),
    async run(ctx: ToolContext, args) {
      const store = ctx.deps.store
      if (args.check_id) {
        const check = await store.getInventoryCheck(args.check_id.trim())
        if (!check) return { found: false, message: 'No check with that id.' }
        return { found: true, ...checkView(check), requested: check.requested, rules: RULES }
      }
      const po = args.customer_po_id
        ? await store.getCustomerPo(args.customer_po_id.trim())
        : args.po_no
          ? ((await store.findCustomerPosByNumber(args.po_no.trim()))[0] ?? null)
          : null
      if (!po) return { found: false, message: 'No received PO with that number. SAP sales orders: use customer_po_status.' }
      const check = await store.latestInventoryCheck(po.id)
      return {
        found: true,
        customerPo: {
          id: po.id,
          poNo: po.poNo,
          revision: po.revision,
          status: po.status,
          party: po.partyName,
          cardCode: po.cardCode,
          site: po.siteCode,
          poDate: po.poDate,
          deliveryDate: po.deliveryDate,
          total: po.total,
          reviewReason: po.reviewReason,
          repeatOf: po.repeatOf.map((hit) => ({ doc: hit.docNo, date: hit.docDate, invoices: hit.invoices, status: hit.status })),
          lines: po.lines.map((line) => ({
            line: line.lineNo,
            article: line.articleNo,
            description: line.description,
            qty: line.qty,
            uom: line.uom,
            pcs: line.pcs,
            item: line.itemCode,
            matchedBy: line.matchMethod,
            pricePerPiece: line.unitPrice,
            note: line.note,
          })),
        },
        check: check ? checkView(check) : null,
        rules: RULES,
      }
    },
  }),
]

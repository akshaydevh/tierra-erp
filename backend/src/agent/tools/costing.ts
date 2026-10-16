import { z } from 'zod/v4'
import { FINANCE_ROLES } from '../../db/types'
import { istDay, parseReportDate } from '../../domain/daily-report'
import { addMonths, monthLabel, parseMonth } from '../../domain/months'
import { NO_LABOUR, findFgItems, productionCost, productionCosts, skuMargins } from '../../queries/costing'
import { buildDailyCosting, perKg } from '../../queries/daily-costing'
import { defaultCostingDate } from '../../workflows/daily-costing'
import { defaultMisMonth, perKgOf } from '../../domain/mis'
import { buildMis } from '../../queries/mis'
import { normalizeDocNo } from '../refs'
import { partyCards } from './finance'
import { defineTool, isoDay, notFound, type ToolContext } from './types'

/**
 * Costing tools (plan §3.4, M): what a production order cost and the material margin per SKU or customer. Manager and
 * admin only. SAP has material cost only, so every answer carries that note: labour and overheads are never guessed.
 */

const monthArg = z.string().min(3).max(20).describe('A month: YYYY-MM, or as written ("July", "jul 2026", "last month")')

function asOf(ctx: ToolContext): string {
  return ctx.dataAsOf ?? ctx.referenceDay
}

async function itemCodes(ctx: ToolContext, item: string): Promise<{ codes: string[]; names: Array<{ itemCode: string; itemName: string }> }> {
  const found = await findFgItems(ctx.deps.sapSql, item)
  return { codes: found.map((row) => row.itemCode), names: found }
}

export const costingTools = [
  defineTool({
    name: 'production_cost',
    description:
      'Material cost of production from SAP. With doc_no (a production order, PR/26-27/101 or "PR 101"): what was issued to it, returned, received, the cost per piece and per kg and the cost by material (banana, oil, laminate ...). Without: finished-goods production orders with output in a date range (default this month), filtered by item or customer, with totals and the weighted cost per kg. Material cost only: SAP holds no labour or overhead cost.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({
      doc_no: z.string().min(2).max(40).optional().describe('A production order number, e.g. PR/26-27/101 or "PR 101"'),
      item: z.string().min(2).max(80).optional().describe('A finished-good code (FG…) or words of its name'),
      customer: z.string().min(2).max(80).optional(),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    async run(ctx, args) {
      if (args.doc_no) {
        const docNo = normalizeDocNo(args.doc_no, ctx.referenceDay) ?? args.doc_no.trim().toUpperCase()
        const row = await productionCost(ctx.deps.sapSql, { docNo })
        if (!row) return notFound(ctx, `Production order ${docNo}`)
        return {
          found: true,
          docNo: row.docNo,
          item: `${row.itemCode} ${row.itemName ?? ''}`.trim(),
          status: row.status,
          type: row.type,
          customer: row.customerName,
          producedPcs: row.producedQty,
          producedKg: row.producedKg,
          issued: row.issuedValue,
          returnedToStock: row.returnedValue,
          materialCost: row.materialCost,
          receivedAtValue: row.producedValue,
          costPerPc: row.costPerPc,
          costPerKg: row.costPerKg,
          byMaterial: row.breakdown,
          lastReceipt: row.lastReceipt,
          note: NO_LABOUR,
        }
      }
      const to = args.to ?? asOf(ctx)
      const from = args.from ?? `${to.slice(0, 7)}-01`
      let codes: string[] | null = null
      if (args.item) {
        codes = (await itemCodes(ctx, args.item)).codes
        if (!codes.length) return { found: false, message: `No finished good matches "${args.item}".` }
      }
      const cards = args.customer ? await partyCards(ctx, args.customer) : null
      if (cards && cards.length === 0) return { found: false, message: `No customer matches "${args.customer}".` }
      const found = await productionCosts(ctx.deps.sapSql, { itemCodes: codes, cardCodes: cards, from, to, pageSize: 10 })
      return {
        from,
        to,
        ...found.totals,
        rows: found.rows.map((row) => ({
          docNo: row.docNo,
          item: row.itemCode,
          customer: row.customerName,
          producedPcs: row.producedQty,
          materialCost: row.materialCost,
          costPerPc: row.costPerPc,
          costPerKg: row.costPerKg,
          lastReceipt: row.lastReceipt,
        })),
        note: NO_LABOUR,
      }
    },
  }),
  defineTool({
    name: 'sku_margin',
    description:
      'Material margin from SAP over whole months (default: the SAP data month): invoiced price per piece against the material cost per piece (what SAP valued that SKU\'s production at in those months; SAP\'s cost of goods sold at invoice where it was not produced), per SKU (by=sku, default) or per customer (by=customer). Filter by item and/or customer. Also gives SAP\'s COGS per piece. Material cost only: no labour or overheads.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({
      item: z.string().min(2).max(80).optional().describe('A finished-good code (FG…) or words of its name'),
      party: z.string().min(2).max(80).optional().describe('A customer: short name (Mom, Wipro), part of its SAP name, or card code'),
      from_month: monthArg.optional(),
      to_month: monthArg.optional(),
      by: z.enum(['sku', 'customer']).optional(),
    }),
    async run(ctx, args) {
      const reference = asOf(ctx)
      const to = (args.to_month && parseMonth(args.to_month, reference)) || `${reference.slice(0, 7)}-01`
      const from = (args.from_month && parseMonth(args.from_month, reference)) || to
      if (from > to) return { error: 'from_month is after to_month.' }
      if (from < addMonths(to, -35)) return { error: 'Ask for at most three years at a time.' }
      let codes: string[] | null = null
      let matched: Array<{ itemCode: string; itemName: string }> = []
      if (args.item) {
        const found = await itemCodes(ctx, args.item)
        if (!found.codes.length) return { found: false, message: `No finished good matches "${args.item}".` }
        codes = found.codes
        matched = found.names
      }
      const cards = args.party ? await partyCards(ctx, args.party) : null
      if (cards && cards.length === 0) return { found: false, message: `No customer matches "${args.party}".` }
      const by = args.by ?? 'sku'
      const result = await skuMargins(ctx.deps.sapSql, { from, to, by, itemCodes: codes, cardCodes: cards, limit: 10 })
      return {
        period: from === to ? monthLabel(from) : `${monthLabel(from)} to ${monthLabel(to)}`,
        by,
        matchedItems: matched.length > 1 ? matched.slice(0, 10) : undefined,
        count: result.count,
        totals: result.totals,
        rows: result.rows.map(({ key: _key, ...row }) => row),
        note: `${NO_LABOUR} Prices are invoice line values before GST; credit notes are not netted.`,
      }
    },
  }),
  defineTool({
    name: 'daily_costing_report',
    description:
      "The daily costing report for one production day (finance's costing sheet from SAP): per finished good made that day, kg and pouches, sales value at the customer's invoice price, banana & cassava / packing / oil / flavour cost, margin on material, LPG, and the contribution after those, each also per kg. Returns the figures and sends the PDF into this chat after your reply. Labour, power, water, repairs and fixed costs are not in SAP and are left out: say so.",
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({
      date: z
        .string()
        .min(1)
        .max(40)
        .optional()
        .describe('The production day: YYYY-MM-DD, or as written ("4 July", "4/7", "yesterday"). Leave out for the last production day in SAP.'),
    }),
    async run(ctx, args) {
      const today = istDay(ctx.deps.now())
      const date = args.date ? parseReportDate(args.date, today) : await defaultCostingDate(ctx.deps.sapSql, ctx.deps.now(), ctx.dataAsOf)
      if (!date) return { error: `"${args.date}" is not a day I can read. Use YYYY-MM-DD.` }
      const payload = await buildDailyCosting(ctx.deps.sapSql, { date, dataAsOf: ctx.dataAsOf, now: ctx.deps.now() })
      if (!ctx.effects.some((effect) => effect.kind === 'send_costing_report' && effect.date === date)) {
        ctx.effects.push({ kind: 'send_costing_report', date })
      }
      const sending = { queued: true, pdf: `daily-costing-${date}.pdf`, date }
      if (payload.kind !== 'full') return { ...sending, found: false, message: payload.notes[0] }
      const figures = (c: (typeof payload.columns)[number]) => ({
        kg: c.kg,
        pouches: c.pouches,
        pricePerPouch: c.pricePerPouch,
        sales: c.sales,
        costs: c.lines,
        materialCost: c.materialCost,
        materialCostPerKg: perKg(c.materialCost, c.kg),
        marginOnMaterial: c.marginOnMaterial,
        marginPerKg: perKg(c.marginOnMaterial, c.kg),
        contributionAfterSapCosts: c.contribution,
      })
      return {
        ...sending,
        found: true,
        skus: payload.columns.map((c) => ({ item: `${c.itemCode} ${c.itemName}`, customers: c.customers, orders: c.orders, ...figures(c) })),
        total: figures(payload.total),
        bananaIssuedKg: payload.total.bananaKg,
        yieldPct: payload.yieldPct,
        notInSap: payload.notInSap,
      }
    },
  }),
  defineTool({
    name: 'mis_report',
    description:
      "The monthly MIS (finance's MIS workbook from SAP): the Costing P&L for the financial year to date (production kg, sales value of production, materials, margin on materials, variable costs, contribution, fixed costs, EBITDA, each per kg), the month per MIS customer, the margin comparison by month and the EBITDA reconciliation. Returns the month's figures and sends the PDF into this chat after your reply. Labour comes from the HR payroll when it is loaded for the month, else SAP's salary journal: say which.",
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({ month: monthArg.optional() }),
    async run(ctx, args) {
      const today = istDay(ctx.deps.now())
      const month = args.month ? parseMonth(args.month, today) : defaultMisMonth(ctx.dataAsOf, today)
      if (!month) return { error: `"${args.month}" is not a month I can read. Use YYYY-MM.` }
      const payload = await buildMis(ctx.deps, { month, dataAsOf: ctx.dataAsOf, now: ctx.deps.now() })
      if (!ctx.effects.some((effect) => effect.kind === 'send_mis_report' && effect.month === month)) ctx.effects.push({ kind: 'send_mis_report', month })
      const sending = { queued: true, pdf: `mis-${month.slice(0, 7)}.pdf`, month: monthLabel(month) }
      if (payload.noData) return { ...sending, found: false, message: payload.notes[0] }
      const figures = (p: typeof payload.current) => ({
        productionKg: p.productionKg,
        sales: p.sales,
        materials: p.materials,
        marginOnMaterials: p.mom,
        momPerKg: perKgOf(p.mom, p.productionKg),
        variableCosts: p.variable,
        contribution: p.contribution,
        fixedCosts: p.fixed,
        otherIncome: p.otherIncome,
        ebitda: p.ebitda,
        ebitdaPerKg: perKgOf(p.ebitda, p.productionKg),
      })
      return {
        ...sending,
        found: true,
        month: figures(payload.current),
        financialYearToDate: figures(payload.fyTotal),
        labour: payload.current.labourSource === 'hr' ? 'HR payroll' : payload.current.labourSource === 'gl' ? "SAP salary journal (HR payroll not loaded)" : 'none',
        customers: payload.customers.slice(0, 12).map((c) => ({ customer: c.label, kg: c.kg, sales: c.sales, marginOnMaterials: c.mom, momPerKg: perKgOf(c.mom, c.kg), contribution: c.contribution })),
        reconciliation: payload.reconciliation,
        notes: payload.notes,
      }
    },
  }),
]

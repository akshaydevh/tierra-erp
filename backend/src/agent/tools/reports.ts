import { z } from 'zod/v4'
import { DAILY_INPUT_ROLES, FINANCE_ROLES, MANPOWER_KEYS, type DailyInputsPatch, type Manpower } from '../../db/types'
import { buildDailyReport, defaultInputDate, defaultReportDate, istDay, manpowerTotal, parseReportDate } from '../../domain/daily-report'
import { defineTool } from './types'

/**
 * The daily report in the tool loop: daily_report (manager, admin) reads a day's figures and queues the PDF for the
 * chat after the reply; set_daily_inputs (office, QA, admin) queues the inputs a person typed in their own words
 * ("we were 85 today, 11 tonnes of banana came"). Both act only after the reply; the commands *manpower …* and
 * *banana …* do the same without the model.
 */

const dayArg = z
  .string()
  .min(1)
  .max(40)
  .describe('The report day: YYYY-MM-DD, or as written ("15 July", "15/7", "yesterday"). Leave out for the default: yesterday, or the SAP data date when that is earlier.')

export const reportTools = [
  defineTool({
    name: 'daily_report',
    description:
      "The finance daily report for one day (bank opening / receipts / payments / closing per bank, outwards per customer with the month to date, inwards, production flags, manpower). Returns the figures and sends the PDF into this chat after your reply. A day after the SAP data date gives the inputs-only page.",
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({ date: dayArg.optional() }),
    async run(ctx, args) {
      const today = istDay(ctx.deps.now())
      const date = args.date ? (parseReportDate(args.date, today) ?? null) : defaultReportDate(ctx.deps.now(), ctx.dataAsOf)
      if (!date) return { error: `"${args.date}" is not a day I can read. Use YYYY-MM-DD.` }
      const payload = await buildDailyReport(ctx.deps, { date })
      if (!ctx.effects.some((effect) => effect.kind === 'send_daily_report' && effect.date === date)) {
        ctx.effects.push({ kind: 'send_daily_report', date })
      }
      const sending = { queued: true, pdf: `daily-report-${date}.pdf` }
      if (payload.kind === 'inputs_only') {
        return { ...sending, date, inputsOnly: true, message: payload.footnotes[0], manpowerTotal: payload.manpower.total }
      }
      return {
        ...sending,
        date,
        basis: payload.basis,
        banks: payload.banks.map(({ glCode: _gl, houseBank: _house, ...bank }) => bank),
        receipts: payload.receipts.map((line) => ({ label: line.label, bank: line.bank, amount: line.amount })),
        payments: payload.payments.map((line) => ({ label: line.label, bank: line.bank, amount: line.amount })),
        outwards: payload.outwards,
        inwards: payload.inwards.filter((row) => row.quantity).map((row) => ({ item: row.label, quantity: row.quantity })),
        manpowerTotal: payload.manpower.total,
        missing: payload.missing,
      }
    },
  }),
  defineTool({
    name: 'set_daily_inputs',
    description:
      'Save what the daily report needs from people for a day (leave the day out unless the message names one: then it is yesterday before noon India time, today after): manpower in its 8 categories, the gate estimate of banana / cassava received (kg), production / packing / cartoning yes or no, notes (only when the message says "note:" and the text after it). Saved after your reply, and only what the message itself says, for the day it names.',
    scope: 'internal',
    roles: DAILY_INPUT_ROLES,
    args: z.object({
      date: dayArg.optional(),
      manpower: z
        .object(Object.fromEntries(MANPOWER_KEYS.map((key) => [key, z.number().int().min(0).max(10_000)])) as Record<(typeof MANPOWER_KEYS)[number], z.ZodNumber>)
        .optional()
        .describe('All 8 counts: office, qc, operators, gents_unloading, ladies, temp_ladies, security, temporary'),
      banana_kg: z.number().positive().max(1_000_000).optional(),
      cassava_kg: z.number().positive().max(1_000_000).optional(),
      production: z.boolean().optional(),
      packing: z.boolean().optional(),
      cartoning: z.boolean().optional(),
      notes: z.string().max(500).optional(),
    }),
    async run(ctx, args) {
      const date = args.date ? parseReportDate(args.date, istDay(ctx.deps.now())) : defaultInputDate(ctx.deps.now())
      if (!date) return { error: `"${args.date}" is not a day I can read. Use YYYY-MM-DD.` }
      const patch: DailyInputsPatch = {}
      if (args.manpower) patch.manpower = args.manpower as Manpower
      if (args.banana_kg !== undefined) patch.bananaKgEstimate = args.banana_kg
      if (args.cassava_kg !== undefined) patch.cassavaKgEstimate = args.cassava_kg
      if (args.production !== undefined) patch.productionRun = args.production
      if (args.packing !== undefined) patch.packingRun = args.packing
      if (args.cartoning !== undefined) patch.cartoningRun = args.cartoning
      if (args.notes !== undefined) patch.notes = args.notes.trim() || null
      if (Object.keys(patch).length === 0) return { error: 'Nothing to save: give manpower, a banana / cassava weight, a yes / no or a note.' }
      ctx.effects.push({ kind: 'set_daily_inputs', date, patch })
      return { queued: true, date, manpowerTotal: args.manpower ? manpowerTotal(args.manpower as Manpower) : undefined }
    },
  }),
]

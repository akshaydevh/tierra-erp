import { z } from 'zod/v4'
import { FINANCE_ROLES } from '../../db/types'
import { lineLabel, loadLabelBook } from '../../domain/daily-report'
import {
  ageingGroups,
  bankLinesOn,
  bankPositions,
  cardBalances,
  journalEntries,
  paymentRequests,
  payments,
  round2,
} from '../../queries/finance'
import { monthStart, searchPattern, textArray, type SapSql } from '../../sap/db'
import { defineTool, isoDay, type ToolContext } from './types'

/**
 * Finance tools (plan §3.4, M): bank position, payments, party balances, ageing, payments awaiting SAP approval and
 * journal entries. Manager and admin only: the role gate leaves them out of an office user's tool list, so an office
 * question about bank balances never reaches the data.
 */

const partyArg = z.string().min(2).max(80).describe('A customer or supplier: its short name (Mom, Wipro, Flipkart), part of its SAP name, or its card code')

function asOf(ctx: ToolContext): string {
  return ctx.dataAsOf ?? ctx.referenceDay
}


/**
 * The cards a party name means: an alias ("Mom") or a card code gives that card and every card of the same company
 * (PAN); otherwise cards whose name matches. Empty when nothing matches.
 */
export async function partyCards(ctx: ToolContext, party: string): Promise<string[]> {
  const sql: SapSql = ctx.deps.sapSql
  const wanted = party.trim()
  const aliases = await ctx.deps.store.listPartyAliases()
  const byAlias = aliases.filter((row) => row.alias.toLowerCase() === wanted.toLowerCase()).map((row) => row.cardCode)
  const seeds = byAlias.length ? byAlias : /^[CV]\d{3,5}$/i.test(wanted) ? [wanted.toUpperCase()] : []
  if (seeds.length) {
    const rows = await sql`
      select b.card_code from erp.bp_balances b
      where b.group_key in (select group_key from erp.bp_balances where card_code = any(${textArray(seeds)}::text[]))`
    return rows.map((row) => String(row.card_code))
  }
  const like = searchPattern(wanted)
  const rows = await sql`select card_code from erp.parties where card_name ilike ${like} or pan ilike ${like} limit 60`
  return rows.map((row) => String(row.card_code))
}

export const financeTools = [
  defineTool({
    name: 'bank_position',
    description:
      'Bank and cash balances on a day: opening, money in, money out and closing per account (SBI, HDFC, ICICI, cash), with each line of that day labelled (party, purpose, transfers between own banks). Defaults to the SAP data date.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({ date: isoDay.optional() }),
    async run(ctx, args) {
      const date = args.date ?? asOf(ctx)
      const moves = (await ctx.deps.store.listBankLineReattributions()).map((row) => ({ transId: row.transId, lineId: row.lineId, reportDate: row.reportDate }))
      const [positions, lines, book] = await Promise.all([
        bankPositions(ctx.deps.sapSql, date, moves),
        bankLinesOn(ctx.deps.sapSql, date, moves),
        loadLabelBook(ctx.deps.store),
      ])
      return {
        date,
        accounts: positions
          .filter((row) => row.kind === 'bank' || row.closing !== 0 || row.receipts !== 0 || row.payments !== 0)
          .map(({ glCode: _gl, ...row }) => row),
        totalClosing: round2(positions.reduce((sum, row) => sum + row.closing, 0)),
        lines: lines.map((line) => ({
          bank: line.bank,
          label: lineLabel(line, book),
          in: line.debit || undefined,
          out: line.credit || undefined,
          memo: line.paymentMemo ?? line.memo,
          ref: line.transType === '24' ? `RT ${line.sourceNo}` : line.transType === '46' ? `PA ${line.sourceNo}` : `JE ${line.transId}`,
          datedInSap: line.moved ? line.refDate : undefined,
        })),
      }
    },
  }),
  defineTool({
    name: 'payments',
    description:
      'Incoming receipts (direction in) or outgoing payments (out) in SAP, newest first: top 10 with the total count and amount. Filter by party, by text in the memo or purpose account (e.g. "salary", "GST", "electricity"), and by date. Defaults to this month.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({
      direction: z.enum(['in', 'out']).optional(),
      party: partyArg.optional(),
      text: z.string().max(80).optional().describe('Text in the memo, the purpose account or the payment number'),
      from: isoDay.optional(),
      to: isoDay.optional(),
    }),
    async run(ctx, args) {
      const to = args.to ?? asOf(ctx)
      const from = args.from ?? monthStart(to)
      const cards = args.party ? await partyCards(ctx, args.party) : null
      if (cards && cards.length === 0) return { found: false, message: `No customer or supplier matches "${args.party}".` }
      const found = await payments(ctx.deps.sapSql, { direction: args.direction, cardCodes: cards, q: args.text, from, to, pageSize: 10 })
      return {
        from,
        to,
        count: found.total,
        amount: found.amount,
        rows: found.rows.map((row) => ({
          docNo: row.docNo,
          direction: row.direction,
          date: row.docDate,
          party: row.cardName ?? row.purposeName,
          bank: row.bank,
          amount: row.amount,
          memo: row.memo,
          transfer: row.transfer || undefined,
        })),
      }
    },
  }),
  defineTool({
    name: 'party_balance',
    description:
      "A customer's or supplier's balance from SAP's ledger: what they owe Tierra (customers) or Tierra owes them (suppliers), per card and netted for the company (all branches with the same PAN), with how much of it is overdue.",
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({ party: partyArg }),
    async run(ctx, args) {
      const cards = await partyCards(ctx, args.party)
      if (cards.length === 0) return { found: false, message: `No customer or supplier matches "${args.party}".` }
      const rows = await cardBalances(ctx.deps.sapSql, { cardCodes: cards, limit: 30 })
      const net = (type: string) => round2(rows.filter((row) => row.cardType === type).reduce((sum, row) => sum + row.owed, 0))
      return {
        asOf: asOf(ctx),
        customerNet: net('customer'),
        supplierNet: net('supplier'),
        cards: rows.map((row) => ({
          cardCode: row.cardCode,
          name: row.cardName,
          type: row.cardType,
          owed: row.owed,
          overdue: round2(row.buckets['1_30'] + row.buckets['31_60'] + row.buckets['61_90'] + row.buckets['91_180'] + row.buckets.over_180),
          over90: round2(row.buckets['91_180'] + row.buckets.over_180),
          lastMoved: row.lastMoved,
        })),
      }
    },
  }),
  defineTool({
    name: 'ageing',
    description:
      'Receivables (what customers owe) or payables (what Tierra owes suppliers) aged as of the SAP data date, netted per company (PAN): buckets not due / 1-30 / 31-60 / 61-90 / 91-180 / over 180 days, largest first, with the totals.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({ side: z.enum(['receivable', 'payable']), party: partyArg.optional() }),
    async run(ctx, args) {
      const cards = args.party ? await partyCards(ctx, args.party) : null
      if (cards && cards.length === 0) return { found: false, message: `No customer or supplier matches "${args.party}".` }
      const found = await ageingGroups(ctx.deps.sapSql, { side: args.side, cardCodes: cards, limit: 10 })
      return { asOf: asOf(ctx), groups: found.total, totals: found.totals, rows: found.rows.map(({ groupKey: _key, ...row }) => row) }
    },
  }),
  defineTool({
    name: 'pending_payment_approvals',
    description: 'Outgoing payments waiting for approval in SAP (oldest first): payee or purpose, amount, who raised it and when, with the count and total.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({}),
    async run(ctx) {
      const found = await paymentRequests(ctx.deps.sapSql, { status: 'pending', pageSize: 10 })
      return {
        count: found.total,
        amount: found.amount,
        rows: found.rows.map((row) => ({
          requested: row.requestedAt,
          by: row.originator,
          party: row.cardName ?? row.purposeName,
          amount: row.amount,
          memo: row.memo,
          bank: row.bank,
        })),
      }
    },
  }),
  defineTool({
    name: 'find_journal_entries',
    description:
      'SAP journal entries, newest first (top 10 with their lines): by date range, text in the memo or reference, an account (GL code or card code) or an amount on one of their lines.',
    scope: 'internal',
    roles: FINANCE_ROLES,
    args: z.object({
      from: isoDay.optional(),
      to: isoDay.optional(),
      text: z.string().max(80).optional(),
      account: z.string().max(40).optional().describe('A GL account code (_SYS…) or a card code'),
      amount: z.number().positive().optional(),
      manual_only: z.boolean().optional().describe('Only manual journal entries, not those posted by documents'),
    }),
    async run(ctx, args) {
      return journalEntries(ctx.deps.sapSql, {
        from: args.from,
        to: args.to,
        q: args.text,
        account: args.account,
        amount: args.amount ?? null,
        manualOnly: args.manual_only,
        limit: 10,
      })
    },
  }),
]

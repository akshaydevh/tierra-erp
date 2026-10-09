import { z } from 'zod/v4'
import { PAYROLL_ROLES } from '../../db/types'
import { lastDayOf, monthLabel, parseMonth } from '../../domain/months'
import {
  attendanceMonth,
  employeePay,
  findEmployees,
  hrMeta,
  hrOrNull,
  leaveSummary,
  payrollSummary,
  reconciliation,
  type EmployeeMatch,
} from '../../queries/payroll'
import { isNotImported } from '../../queries/meta'
import { NAMES_WITHHELD, namesAsked } from '../hr-gate'
import { defineTool, isoDay, type ToolContext } from './types'

/**
 * HR tools (plan §3.4, A): payroll, attendance and leave from the HR spreadsheets (schema hr; SAP has none of it).
 * Admin only, so they are never offered to anyone else and never in a group (a group is a party audience). Totals by
 * default; names and one person's pay only when the message itself asks for them (hr-gate.ts), whatever the model
 * passes.
 */

const NOT_LOADED = { found: false, message: 'The HR files have not been imported on this server yet (run.py hr).' }
const SAME_STAFF =
  'Voyon and the salary register are the same permanent staff (the register has a few more): never add them. Temporary workers are a separate sheet. Figures come from the HR files, not SAP.'

const monthArg = z.string().min(3).max(20).describe('A month: YYYY-MM, or as written ("June", "jun 2026", "last month"). Default: the latest on file.')
const employeeArg = z.string().min(2).max(60).describe('One person: their employee code (TF905, T99, TFL0999) or name. Only when the message asks for that person.')
const namesArg = z.boolean().optional().describe('List people by name. Only honoured when the message itself asks for names / who / each person.')

type Months = { months: string[]; attendance: string[] }

async function monthsOnFile(ctx: ToolContext): Promise<Months | null> {
  const meta = await hrOrNull(() => hrMeta(ctx.deps.sapSql))
  return meta ? { months: meta.months, attendance: meta.attendanceMonths } : null
}

function pickMonth(ctx: ToolContext, asked: string | undefined, available: string[]): string | null {
  const reference = ctx.dataAsOf ?? ctx.referenceDay
  if (!asked) return available[0] ?? null
  return parseMonth(asked, reference, available)
}

async function onePerson(ctx: ToolContext, query: string): Promise<{ person: EmployeeMatch } | { error: string; matches?: string[] }> {
  if (!namesAsked(ctx.question)) return { error: NAMES_WITHHELD }
  const found = await findEmployees(ctx.deps.sapSql, query)
  if (found.length === 0) return { error: `No employee matches "${query}".` }
  if (found.length > 1) return { error: `"${query}" matches ${found.length} people; ask with their code.`, matches: found.map((row) => `${row.name} (${row.codeVoyon ?? row.codeRegister})`) }
  return { person: found[0]! }
}

async function guarded<T>(work: () => Promise<T>): Promise<T | typeof NOT_LOADED> {
  try {
    return await work()
  } catch (error) {
    if (isNotImported(error)) return NOT_LOADED
    throw error
  }
}

export const hrTools = [
  defineTool({
    name: 'payroll_summary',
    description:
      "A month's payroll from the HR files: the Voyon payroll (headcount, earned, deductions, PF, ESI, net, by department), the salary register by category (Office & Admin, Peeling, Production, Sales Promotion) and the temporary workers' sheet, with SAP's salary journal entry and salary payments to compare. Totals only. With employee: that one person's pay (only when the message asks for them by name or code).",
    scope: 'internal',
    roles: PAYROLL_ROLES,
    args: z.object({ month: monthArg.optional(), employee: employeeArg.optional(), names: namesArg }),
    async run(ctx, args) {
      return guarded(async () => {
        const files = await monthsOnFile(ctx)
        if (!files) return NOT_LOADED
        const month = pickMonth(ctx, args.month, files.months)
        if (!month) return { found: false, message: `"${args.month}" is not a month I can read.` }
        if (!files.months.includes(month)) {
          return { found: false, message: `No payroll on file for ${monthLabel(month)}. On file: ${files.months.map(monthLabel).join(', ') || 'none'}.` }
        }
        if (args.employee) {
          const who = await onePerson(ctx, args.employee)
          if ('error' in who) return who
          const lines = await employeePay(ctx.deps.sapSql, who.person.employeeId, month)
          return {
            month: monthLabel(month),
            person: { name: who.person.name, voyonCode: who.person.codeVoyon, registerCode: who.person.codeRegister, designation: who.person.designation },
            pay: lines.map(({ employeeId: _id, runId: _run, ...line }) => line),
            note: lines.length ? SAME_STAFF : `No pay line for this person in ${monthLabel(month)}.`,
          }
        }
        const names = Boolean(args.names) && namesAsked(ctx.question)
        const [summary, rec] = await Promise.all([
          payrollSummary(ctx.deps.sapSql, month, { names }),
          reconciliation(ctx.deps.sapSql, month).catch((error: unknown) => {
            if (isNotImported(error)) return null
            throw error
          }),
        ])
        return {
          month: monthLabel(month),
          payrolls: summary.runs.map((run) => ({
            source: run.label,
            people: run.headcount,
            earned: run.totalEarning,
            deductions: run.deductions,
            pf: run.pf,
            esi: run.esi,
            net: run.net,
            basicApproved: run.source === 'voyon' ? run.basic : undefined,
            byCategory: run.categories.map((cat) => ({ category: cat.label, people: cat.people, net: cat.net })),
          })),
          sap: rec
            ? { salaryJournal: rec.journalTotal, employerPfEsi: rec.employerContribution, salaryPaymentsNextMonth: rec.paidNextMonth }
            : undefined,
          people: names ? summary.people?.map((line) => ({ name: line.name, code: line.code, payroll: line.source, category: line.category, net: line.net })) : undefined,
          namesWithheld: args.names && !names ? NAMES_WITHHELD : undefined,
          note: SAME_STAFF,
        }
      })
    },
  }),
  defineTool({
    name: 'attendance',
    description:
      'Attendance from the salary register\'s monthly grid (codes P present, Offday worked on an off day, W/OFF weekly off, LWP leave without pay, CL casual leave, PH paid holiday): counts per code and per day for a month or one date. Totals only. With employee: that person\'s month; names: who had which code (both only when the message asks for people).',
    scope: 'internal',
    roles: PAYROLL_ROLES,
    args: z.object({ month: monthArg.optional(), date: isoDay.optional(), employee: employeeArg.optional(), names: namesArg }),
    async run(ctx, args) {
      return guarded(async () => {
        const files = await monthsOnFile(ctx)
        if (!files) return NOT_LOADED
        const month = args.date ? `${args.date.slice(0, 7)}-01` : pickMonth(ctx, args.month, files.attendance)
        if (!month) return { found: false, message: `"${args.month}" is not a month I can read.` }
        if (!files.attendance.includes(month)) {
          return { found: false, message: `No attendance on file for ${monthLabel(month)}. On file: ${files.attendance.map(monthLabel).join(', ') || 'none'}.` }
        }
        if (args.employee) {
          const who = await onePerson(ctx, args.employee)
          if ('error' in who) return who
          const grid = await attendanceMonth(ctx.deps.sapSql, month, { names: true, date: args.date ?? null })
          const row = grid.rows?.find((person) => person.employeeId === who.person.employeeId)
          if (!row) return { found: false, message: `${who.person.name} is not on the attendance sheet for ${monthLabel(month)}.` }
          const counts: Record<string, number> = {}
          for (const code of Object.values(row.marks)) counts[code] = (counts[code] ?? 0) + 1
          return { month: monthLabel(month), person: who.person.name, counts, days: args.date ? row.marks : undefined }
        }
        const names = Boolean(args.names) && namesAsked(ctx.question)
        const grid = await attendanceMonth(ctx.deps.sapSql, month, { names, date: args.date ?? null })
        const byCode = names && grid.rows
          ? Object.fromEntries(
              Object.keys(grid.codes).map((code) => [
                code,
                grid.rows!.filter((person) => Object.values(person.marks).includes(code)).map((person) => person.name),
              ]),
            )
          : undefined
        return {
          period: args.date ?? monthLabel(month),
          people: grid.people,
          codes: grid.codes,
          days: args.date ? undefined : grid.perDay.filter((row) => row.present + row.leave + row.lwp + row.off > 0),
          namesByCode: args.date ? byCode : undefined,
          lowestAttendance: names && !args.date
            ? [...(grid.rows ?? [])].sort((a, b) => b.lwp - a.lwp).slice(0, 10).map((person) => ({ name: person.name, present: person.present, lwp: person.lwp }))
            : undefined,
          namesWithheld: args.names && !names ? NAMES_WITHHELD : undefined,
          note: 'Permanent staff on the salary register\'s attendance sheet; temporary workers are not on it.',
        }
      })
    },
  }),
  defineTool({
    name: 'leave_requests',
    description:
      'Leave requests from Voyon (casual leave, unpaid leave …) in a date range (default: everything on file): counts and days by type and status. Totals only; with employee or names (only when the message asks for people) the requests themselves.',
    scope: 'internal',
    roles: PAYROLL_ROLES,
    args: z.object({ from: isoDay.optional(), to: isoDay.optional(), month: monthArg.optional(), employee: employeeArg.optional(), names: namesArg }),
    async run(ctx, args) {
      return guarded(async () => {
        let from = args.from ?? null
        let to = args.to ?? null
        if (args.month) {
          const month = parseMonth(args.month, ctx.dataAsOf ?? ctx.referenceDay)
          if (!month) return { found: false, message: `"${args.month}" is not a month I can read.` }
          from = month
          to = lastDayOf(month)
        }
        let codes: string[] | null = null
        if (args.employee) {
          const who = await onePerson(ctx, args.employee)
          if ('error' in who) return who
          codes = [who.person.codeVoyon ?? who.person.employeeId]
        }
        const names = codes !== null || (Boolean(args.names) && namesAsked(ctx.question))
        const found = await leaveSummary(ctx.deps.sapSql, { from, to, codes, names })
        return {
          ...found,
          rows: names ? found.rows : undefined,
          namesWithheld: args.names && !names ? NAMES_WITHHELD : undefined,
        }
      })
    },
  }),
]

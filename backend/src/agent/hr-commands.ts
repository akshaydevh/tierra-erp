import { PAYROLL_ROLES } from '../db/types'
import { monthLabel, parseMonth } from '../domain/months'
import { importMeta, isNotImported } from '../queries/meta'
import { hrMeta, hrOrNull, payrollSummary, reconciliation, type PayrollSummary, type Reconciliation } from '../queries/payroll'
import type { Person } from '../whatsapp/people'
import type { ChatKind, IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { PAYROLL_ONLY, isHrQuestion } from './hr-gate'
import { sendBotText } from './outbox'
import { istToday } from './refs'

/**
 * Payroll on WhatsApp without the model (plan §4 P7):
 * - "payroll [June]", "salary June 2026", "payroll summary": the admin gets the month's totals by category, never
 *   names (names only through the tool loop, when the message asks for a person);
 * - anyone else asking about payroll, attendance or leave gets a plain no.
 * Group chats never get either: a group is a customer's, and HR is internal.
 */

const PAYROLL = /^(?:(?:please\s+)?(?:send|show|give|share)\s+(?:me\s+)?)?(?:the\s+)?(?:payroll|salary|salaries|wages)(?:\s+(?:summary|totals?|report))?(?:\s+(?:for|of|in))?\s*(.*?)\s*[.?!]*$/i

export type PayrollCommand = { monthText: string | null }

/** "payroll June" -> June; "payroll" -> the latest; "salary of TF905" is not this command (null). */
export function parsePayrollCommand(text: string, reference: string): PayrollCommand | null {
  const match = PAYROLL.exec(text.trim())
  if (!match) return null
  const rest = match[1]?.trim() ?? ''
  if (!rest) return { monthText: null }
  const monthOnly = /^(?:the\s+)?(?:month\s+of\s+)?[a-z]{3,9}\.?(?:\s*['’-]?\s*\d{2,4})?(?:\s+month)?$|^\d{4}-\d{1,2}$|^\d{1,2}[/.-]\d{2,4}$|^(?:this|last|previous|current)\s+month$/i
  return monthOnly.test(rest) && parseMonth(rest, reference) ? { monthText: rest } : null
}

const rupees = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 })
const inr = (n: number) => `₹${rupees.format(Math.round(n))}`

/** The WhatsApp text for a month's payroll: totals by category, no names. */
export function payrollText(summary: PayrollSummary, rec: Reconciliation | null): string {
  const lines = [`*Payroll ${monthLabel(summary.month)}* (HR files; SAP keeps only the salary journal)`]
  for (const run of summary.runs) {
    if (run.source === 'voyon') {
      lines.push(
        '',
        `*Voyon payroll*: ${run.headcount} people, net *${inr(run.net)}* (earned ${inr(run.totalEarning)}, deductions ${inr(run.deductions)}; basic pay ${inr(run.basic)})`,
        ...run.categories.map((cat) => `• ${cat.label}: ${cat.people}, ${inr(cat.net)}`),
      )
    } else if (run.source === 'register') {
      lines.push(
        '',
        `*Salary register by category*: ${run.headcount} people, net *${inr(run.net)}*`,
        ...run.categories.map((cat) => `• ${cat.label}: ${cat.people}, ${inr(cat.net)}`),
      )
    } else {
      lines.push(
        '',
        `*Temporary workers*: ${run.headcount}, net *${inr(run.net)}*`,
        ...run.categories.map((cat) => `• ${cat.label}: ${cat.people}, ${inr(cat.net)}`),
      )
    }
  }
  if (summary.runs.some((run) => run.source === 'voyon') && summary.runs.some((run) => run.source === 'register')) {
    lines.push('', 'Voyon and the register are the same permanent staff: do not add them.')
  }
  if (rec && (rec.journalTotal || rec.paidNextMonth)) {
    lines.push(`SAP: salary journal ${inr(rec.journalTotal)}; salary payments the next month ${inr(rec.paidNextMonth)} (${rec.paymentsNextMonth}).`)
  }
  lines.push('No names here; ask for a person by name or code.')
  return lines.join('\n')
}

export async function handleHrCommand(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!speaker || chatKind === 'group' || !text) return undefined
  const reference = (await importMeta(deps.sapSql)).dataAsOf ?? istToday(deps.now())
  const command = parsePayrollCommand(text, reference)
  if (!command && !isHrQuestion(text)) return undefined
  if (!PAYROLL_ROLES.includes(speaker.role)) return sendBotText(deps, message, PAYROLL_ONLY)
  if (!command) return undefined // the admin's own question: the tool loop, with the HR tools
  const meta = await hrOrNull(() => hrMeta(deps.sapSql))
  if (!meta || meta.months.length === 0) return sendBotText(deps, message, 'The HR files have not been imported yet, so there is no payroll to show.')
  const month = command.monthText ? parseMonth(command.monthText, reference, meta.months) : meta.months[0]!
  if (!month) return undefined
  if (!meta.months.includes(month)) {
    return sendBotText(deps, message, `No payroll on file for ${monthLabel(month)}. On file: ${meta.months.map(monthLabel).join(', ')}.`)
  }
  const [summary, rec] = await Promise.all([
    payrollSummary(deps.sapSql, month),
    reconciliation(deps.sapSql, month).catch((error: unknown) => {
      if (isNotImported(error)) return null
      throw error
    }),
  ])
  return sendBotText(deps, message, payrollText(summary, rec))
}

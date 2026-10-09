import { DAILY_INPUT_ROLES, FINANCE_ROLES, MANPOWER_KEYS, MANPOWER_LABELS, type Manpower, type Role } from '../db/types'
import { dayLabel, defaultInputDate, defaultReportDate, istDay, kgText, manpowerTotal, parseReportDate, parseWholeDate } from '../domain/daily-report'
import { grnLinesOn } from '../queries/finance'
import { importMeta, isNotImported } from '../queries/meta'
import type { Person } from '../whatsapp/people'
import { replyChatJid, deliveryAddress, type ChatKind, type IncomingMessage } from '../whatsapp/parse'
import { generateDailyReport, REPORT_PURPOSE, REPORT_SUBJECT, sendReportTo, type GeneratedReport } from '../workflows/daily-report'
import type { AgentDeps } from './deps'
import { isDeskThread, postToDesk, sendBotText } from './outbox'
import { ensureTierraPrefix } from './send'

/**
 * The daily report's deterministic commands (plan §3.4 step 4), from Tierra's own people in a DM or on the desk:
 * - "manpower 7 6 6 7 19 25 2 13 [for 15/7]": the day's manpower in the sheet's order (office, QA alias, admin);
 * - "banana 11t [for 15/7]", "cassava 2.5 t": the gate estimate beside SAP's GRPO kg (office, QA alias, admin);
 *   without a day both are for yesterday before noon (India time) and for today after; the reply always names the
 *   day, and replying to it with only a day moves what it saved to that day;
 * - "daily report [15 July]", "DR 15/7", "report for 8 Oct", "yesterday's report": the PDF (manager, admin), only
 *   when the day is all that follows ("report 2 cartons damaged on 15/7" is a sentence for the agent).
 * And the finance gate: an office user asking for bank balances or receivables gets a plain no, never the model.
 */

const DATE_TAIL = '(?:\\s+(?:for|on|of|dated)\\s+(.+?))?'
const MANPOWER = new RegExp(`^(?:manpower|man\\s*power|mp)\\s*[:=-]?\\s*(\\d+(?:[\\s,/]+\\d+)*)${DATE_TAIL}\\s*[.!]*$`, 'i')
const ESTIMATE = new RegExp(
  `^(banana|cassava|tapioca)\\s*[:=-]?\\s*(?:approx\\.?|aprox\\.?|about|~)?\\s*(\\d+(?:\\.\\d+)?)\\s*(t|tn|ton|tons|tonne|tonnes|mt|kg|kgs)?\\b${DATE_TAIL}\\s*[.!]*$`,
  'i',
)
const REPORT = /^(?:(?:please\s+)?(?:send|share|give)\s+(?:me\s+)?)?(?:the\s+)?(?:daily\s+report|dr|report)\b(?:\s+(?:for|of|on|dated))?\s*(.*?)\s*[.?!]*$/i
const REPORT_DAY_FIRST = /^(?:(?:please\s+)?(?:send|share|give)\s+(?:me\s+)?)?(yesterday|today)['’]?s?\s+(?:daily\s+)?report\s*[.?!]*$/i

/** Bank balances, receivables, payables, payments: finance questions the office role does not get answers to. */
const FINANCE_QUESTION =
  /\b(?:(?:sbi|hdfc|icici|bank)\b[^.?!]{0,30}\b(?:balance|position|book|statement)|bank\s+balances?|cash\s+(?:position|balance)|receivables?|payables?|ageing|aging|outstanding\s+(?:from|with|of)|who\s+owes|payments?\s+(?:awaiting|pending)\s+approval|daily\s+report)\b/i

export type ManpowerCommand = { counts: number[]; dateText: string | null }
export type EstimateCommand = { item: 'banana' | 'cassava'; kg: number; dateText: string | null }
export type ReportRequest = { dateText: string | null }

export function parseManpower(text: string): ManpowerCommand | null {
  const match = MANPOWER.exec(text.trim())
  if (!match) return null
  return { counts: match[1]!.split(/[\s,/]+/).filter(Boolean).map(Number), dateText: match[2]?.trim() || null }
}

export function parseEstimate(text: string): EstimateCommand | null {
  const match = ESTIMATE.exec(text.trim())
  if (!match) return null
  const value = Number(match[2])
  const unit = match[3]?.toLowerCase()
  // a bare number is tonnes up to 100 ("banana 11"), kilograms above ("banana 9400")
  const kg = unit ? (unit.startsWith('k') ? value : value * 1000) : value <= 100 ? value * 1000 : value
  return { item: match[1]!.toLowerCase() === 'banana' ? 'banana' : 'cassava', kg, dateText: match[4]?.trim() || null }
}

/** A request for the daily report; null when the text is not one (or names something that is not a day). */
export function parseReportRequest(text: string, today: string): ReportRequest | null {
  const value = text.trim()
  const dayFirst = REPORT_DAY_FIRST.exec(value)
  if (dayFirst) return { dateText: dayFirst[1]! }
  const match = REPORT.exec(value)
  if (!match) return null
  const rest = match[1]?.trim() ?? ''
  if (!rest) return { dateText: null }
  return parseWholeDate(rest, today) ? { dateText: rest } : null
}

export function isFinanceQuestion(text: string): boolean {
  return FINANCE_QUESTION.test(text)
}

const HELP_MANPOWER = `Send the 8 numbers in the sheet's order: ${MANPOWER_KEYS.map((key) => MANPOWER_LABELS[key].toLowerCase()).join(', ')}. For example *manpower 7 6 6 7 19 25 2 13* (add *for 15/7* for another day).`
const FINANCE_ONLY = 'Bank balances, payments, receivables, payables and the daily report are for the manager and the admin.'
const INPUTS_ONLY_ROLES = 'Only the office (QA) or the admin enters the daily report inputs.'

function allowed(roles: readonly Role[], speaker: Person): boolean {
  return roles.includes(speaker.role)
}

function dayFrom(deps: AgentDeps, dateText: string | null): string | null {
  return dateText ? parseReportDate(dateText, istDay(deps.now())) : defaultInputDate(deps.now())
}

/** The first line of every inputs confirmation; a reply to it with only a day moves what it saved. */
function savedFor(date: string): string {
  return `Saved for ${dayLabel(date)} — reply with a date to change.`
}

const SAVED_FOR = /Saved for (\d{1,2} [A-Z][a-z]{2} \d{4}) — reply with a date to change\.\n(Manpower|Banana|Cassava)\b/

const MONTH_INDEX: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }

/** "15 Jul 2026" (dayLabel) -> 2026-07-15 */
function fromDayLabel(label: string): string | null {
  const [d, m, y] = label.split(' ')
  return d && m && y && MONTH_INDEX[m] ? `${y}-${MONTH_INDEX[m]}-${d.padStart(2, '0')}` : null
}

/** A reply of only a day to an inputs confirmation: what it saved moves from the day it names to that day. */
async function moveSavedInputs(deps: AgentDeps, message: IncomingMessage, speaker: Person, text: string): Promise<string | null | undefined> {
  const quoted = SAVED_FOR.exec(message.quotedText ?? '')
  if (!quoted) return undefined
  const target = parseWholeDate(text, istDay(deps.now()))
  const from = fromDayLabel(quoted[1]!)
  if (!target || !from) return undefined
  if (!allowed(DAILY_INPUT_ROLES, speaker)) return sendBotText(deps, message, INPUTS_ONLY_ROLES)
  const what = quoted[2]!.toLowerCase() as 'manpower' | 'banana' | 'cassava'
  if (target === from) return sendBotText(deps, message, `${savedFor(target)}\nIt is already saved for that day.`)
  const saved = await deps.store.getDailyInputs(from)
  const by = { userId: speaker.userId, at: deps.now() }
  if (what === 'manpower') {
    if (!saved?.manpower) return sendBotText(deps, message, `There is no manpower saved for ${dayLabel(from)} to move.`)
    await deps.store.saveDailyInputs(target, { manpower: saved.manpower }, by)
    await deps.store.saveDailyInputs(from, { manpower: null }, by)
    return sendBotText(deps, message, `${savedFor(target)}\nManpower total *${manpowerTotal(saved.manpower)}* moved from ${dayLabel(from)}.`)
  }
  const field = what === 'banana' ? 'bananaKgEstimate' : 'cassavaKgEstimate'
  const kg = saved?.[field]
  if (kg == null) return sendBotText(deps, message, `There is no ${what} estimate saved for ${dayLabel(from)} to move.`)
  await deps.store.saveDailyInputs(target, { [field]: kg }, by)
  await deps.store.saveDailyInputs(from, { [field]: null }, by)
  return sendBotText(deps, message, `${savedFor(target)}\n${what === 'banana' ? 'Banana' : 'Cassava'} *${kgText(kg)}* moved from ${dayLabel(from)}.`)
}

async function sapKg(deps: AgentDeps, date: string, role: 'raw_banana' | 'raw_cassava'): Promise<number | null> {
  try {
    const lines = (await grnLinesOn(deps.sapSql, date)).filter((line) => line.materialRole === role && (line.uom ?? 'kg') === 'kg')
    return lines.length ? lines.reduce((sum, line) => sum + line.qty, 0) : null
  } catch (error) {
    if (isNotImported(error)) return null
    throw error
  }
}

const kgFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

/** Sends a generated report into the chat the request came from (a link on the desk). */
export async function deliverReport(deps: AgentDeps, message: IncomingMessage, report: GeneratedReport): Promise<string> {
  const chat = replyChatJid(message)
  if (isDeskThread(chat)) {
    const body = ensureTierraPrefix(`${report.caption}\n\n[${report.fileName}](/api/documents/${report.documentId})`)
    await postToDesk(deps.store, chat, body, { subjectType: REPORT_SUBJECT, subjectId: report.record.id }, REPORT_PURPOSE)
    return body
  }
  await sendReportTo(deps, { number: deliveryAddress(chat), remoteJid: chat }, report)
  return ensureTierraPrefix(report.caption)
}

/**
 * Returns undefined when the message is none of these commands. Group chats never get them: inputs and the report
 * are internal.
 */
export async function handleReportCommand(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!speaker || chatKind === 'group' || !text) return undefined
  const by = { userId: speaker.userId, at: deps.now() }

  const moved = await moveSavedInputs(deps, message, speaker, text)
  if (moved !== undefined) return moved

  const manpower = parseManpower(text)
  if (manpower) {
    if (!allowed(DAILY_INPUT_ROLES, speaker)) return sendBotText(deps, message, INPUTS_ONLY_ROLES)
    const date = dayFrom(deps, manpower.dateText)
    if (!date) return sendBotText(deps, message, 'Which day? Write it like *for 15/7* or *for 15 July*.')
    if (manpower.counts.length !== MANPOWER_KEYS.length || manpower.counts.some((n) => !Number.isInteger(n) || n > 10_000)) {
      return sendBotText(deps, message, `That is ${manpower.counts.length} number${manpower.counts.length === 1 ? '' : 's'}. ${HELP_MANPOWER}`)
    }
    const values = Object.fromEntries(MANPOWER_KEYS.map((key, index) => [key, manpower.counts[index]!])) as Manpower
    await deps.store.saveDailyInputs(date, { manpower: values }, by)
    const total = manpowerTotal(values)
    const parts = MANPOWER_KEYS.map((key) => `${MANPOWER_LABELS[key].toLowerCase()} ${values[key]}`).join(', ')
    return sendBotText(deps, message, `${savedFor(date)}\nManpower total *${total}* (${parts}).`)
  }

  const estimate = parseEstimate(text)
  if (estimate) {
    if (!allowed(DAILY_INPUT_ROLES, speaker)) return sendBotText(deps, message, INPUTS_ONLY_ROLES)
    const date = dayFrom(deps, estimate.dateText)
    if (!date) return sendBotText(deps, message, 'Which day? Write it like *for 15/7* or *for 15 July*.')
    if (!(estimate.kg > 0) || estimate.kg > 1_000_000) return sendBotText(deps, message, 'Give the weight like *banana 11t* or *banana 11000 kg*.')
    await deps.store.saveDailyInputs(date, estimate.item === 'banana' ? { bananaKgEstimate: estimate.kg } : { cassavaKgEstimate: estimate.kg }, by)
    const sap = await sapKg(deps, date, estimate.item === 'banana' ? 'raw_banana' : 'raw_cassava')
    const sapText = sap != null ? `SAP GRPO ${kgFormat.format(sap)} kg` : 'no GRPO in SAP for that day yet'
    return sendBotText(deps, message, `${savedFor(date)}\n${estimate.item === 'banana' ? 'Banana' : 'Cassava'} *${kgText(estimate.kg)}* (${sapText}).`)
  }

  const request = parseReportRequest(text, istDay(deps.now()))
  if (request) {
    if (!allowed(FINANCE_ROLES, speaker)) return sendBotText(deps, message, FINANCE_ONLY)
    const dataAsOf = (await importMeta(deps.sapSql)).dataAsOf
    const date = request.dateText ? parseReportDate(request.dateText, istDay(deps.now())) : defaultReportDate(deps.now(), dataAsOf)
    if (!date) return undefined
    const report = await generateDailyReport(deps, { date, userId: speaker.userId })
    return deliverReport(deps, message, report)
  }

  if (speaker.role === 'office' && isFinanceQuestion(text)) return sendBotText(deps, message, FINANCE_ONLY)
  return undefined
}

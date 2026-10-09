import type { Store } from '../db/store'
import {
  MANPOWER_KEYS,
  OUTWARDS_BASES,
  asOutwardsBasis,
  type BankLineReattribution,
  type DailyReportInputs,
  type GlLabel,
  type Manpower,
  type OutwardsBasis,
} from '../db/types'
import {
  bankAccounts,
  bankLinesOn,
  bankPositions,
  cutoffTime,
  grnLinesOn,
  outwardsFor,
  productionOn,
  round2,
  tidyAccountName,
  type BankLine,
  type InwardLine,
  type ProductionDay,
} from '../queries/finance'
import { importMeta } from '../queries/meta'
import type { SapSql } from '../sap/db'

/**
 * The finance daily report (goal 4), rebuilt from SAP the way the manual sheet is made
 * (Reference/research/2026-10-08-survey/daily-report.md §2-§4):
 * - bank position per bank: opening, receipts, payments, closing, by the journal's posting date (RefDate), with
 *   re-attributed lines counted on their report day;
 * - receipts and payments one line each, labelled by the party's short name, the GL account's label or the payee in
 *   the memo; transfers between Tierra's own banks show as "Transfer ⇄ <bank>";
 * - outwards per the basis setting, grouped by party label, with the day total and the month to date;
 * - inwards by item row from the day's goods receipts, with the gate estimate (banana / cassava) beside SAP's kg;
 * - production / packing / cartoning from SAP's production orders, receipts and issues unless entered;
 * - manpower from the daily inputs;
 * - footnotes: basis, data date, moved lines and the known differences with the manual sheet.
 */

export const SETTING_BASIS = 'daily_report.outwards_basis'
export const SETTING_CUTOFF = 'daily_report.cutoff'
/** Admin-maintained lines for the "Known differences vs manual sheet" footnote (a JSON list of strings). */
export const SETTING_KNOWN_DIFFERENCES = 'daily_report.known_differences'

export const DEFAULT_BASIS: OutwardsBasis = 'created_window'
export const DEFAULT_CUTOFF = '19:30'

const GENERIC_DIFFERENCES = [
  'Balances are SAP’s ledger; a difference carried on the manual sheet from earlier days is not repeated here.',
  'Receipts are SAP’s receipt documents; the bank statement may show one of them as several credits.',
  'The month total is SAP’s invoice totals to the rupee; the manual sheet may round it.',
]

/** The fixed item rows of the sheet's inwards block, in its order. */
export const INWARD_ITEMS = [
  { key: 'banana', label: 'Banana' },
  { key: 'cassava', label: 'Cassava' },
  { key: 'oil', label: 'Oil' },
  { key: 'diesel', label: 'Diesel' },
  { key: 'gas', label: 'Gas' },
  { key: 'flavour', label: 'Flavour' },
  { key: 'packing', label: 'Packing material' },
  { key: 'laminate', label: 'Laminate' },
  { key: 'caustic', label: 'Caustic' },
  { key: 'other', label: 'Other' },
] as const
export type InwardKey = (typeof INWARD_ITEMS)[number]['key']

export type ActivityFlag = {
  value: boolean | null
  /** input: someone entered it; sap: read from SAP's production documents of the day; null: unknown. */
  source: 'input' | 'sap' | null
  /** What SAP shows, e.g. "PR/26-27/464, PR/26-27/471 posted". */
  detail: string | null
}

export type ReportLine = {
  label: string
  bank: string
  amount: number
  /** The SAP document behind it: RT/26-27/279, PA/26-27/855, a journal entry number. */
  ref: string | null
  memo: string | null
  transfer: boolean
  /** Counted on this day although SAP dates it another day. */
  movedFrom: string | null
}

export type ReportBank = {
  glCode: string
  bank: string
  houseBank: boolean
  opening: number
  receipts: number
  payments: number
  closing: number
}

export type InwardRow = {
  key: InwardKey
  label: string
  /** What the sheet prints in the quantity column, e.g. "11 t (SAP GRPO 9,400 kg)". */
  quantity: string | null
  sapQty: Array<{ qty: number; uom: string | null }>
  estimateKg: number | null
  remarks: string | null
  grns: string[]
}

export type OutwardsRow = { label: string; amount: number; invoices: string[]; cardCodes: string[] }

export type DailyReportPayload = {
  kind: 'full' | 'inputs_only'
  reportDate: string
  basis: OutwardsBasis
  cutoff: string
  dataAsOf: string | null
  generatedAt: string
  activity: { production: ActivityFlag; packing: ActivityFlag; cartoning: ActivityFlag }
  manpower: { values: Manpower | null; total: number | null }
  banks: ReportBank[]
  receipts: ReportLine[]
  payments: ReportLine[]
  inwards: InwardRow[]
  outwards: { rows: OutwardsRow[]; total: number; monthToDate: number | null; monthLabel: string }
  notes: string | null
  /** What a person still has to enter ("manpower"). */
  missing: string[]
  footnotes: string[]
  knownDifferences: string[]
}

export type ReportDeps = { sapSql: SapSql; store: Store; now: () => Date }

// ------------------------------------------------------------------------------------------------ dates

export function istDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
}

export function addDays(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** The report a person means without a date: yesterday in India, or the SAP data date when that is earlier. */
export function defaultReportDate(now: Date, dataAsOf: string | null): string {
  const yesterday = addDays(istDay(now), -1)
  return dataAsOf && dataAsOf < yesterday ? dataAsOf : yesterday
}

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function validDay(year: number, month: number, dayOfMonth: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dayOfMonth) return null
  return date.toISOString().slice(0, 10)
}

/** A day without a year: the latest such day on or before `today`. */
function latest(month: number, dayOfMonth: number, today: string): string | null {
  const year = Number(today.slice(0, 4))
  const same = validDay(year, month, dayOfMonth)
  if (same && same <= today) return same
  return validDay(year - 1, month, dayOfMonth)
}

/**
 * A report day in what people type: "15 July", "July 15", "15/7", "15/07/2026", "2026-07-15", "15-07-26", "today",
 * "yesterday". A day without a year is the latest one on or before today (India time). Null when there is none.
 */
export function parseReportDate(text: string, today: string): string | null {
  const value = text.trim().toLowerCase()
  if (/\bday before yesterday\b/.test(value)) return addDays(today, -2)
  if (/\byesterday\b/.test(value)) return addDays(today, -1)
  if (/\btoday\b/.test(value)) return today
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(value)
  if (iso) return validDay(Number(iso[1]), Number(iso[2]), Number(iso[3]))
  const dmy = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}|\d{2}))?\b/.exec(value)
  if (dmy) {
    const d = Number(dmy[1])
    const m = Number(dmy[2])
    if (!dmy[3]) return latest(m, d, today)
    const y = dmy[3].length === 2 ? 2000 + Number(dmy[3]) : Number(dmy[3])
    return validDay(y, m, d)
  }
  const month = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?'
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}(?:,?\\s+(\\d{4}))?`).exec(value)
  if (dm) {
    const m = MONTH_NAMES.indexOf(dm[2]!) + 1
    return dm[3] ? validDay(Number(dm[3]), m, Number(dm[1])) : latest(m, Number(dm[1]), today)
  }
  const md = new RegExp(`\\b${month}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`).exec(value)
  if (md) {
    const m = MONTH_NAMES.indexOf(md[1]!) + 1
    return md[3] ? validDay(Number(md[3]), m, Number(md[2])) : latest(m, Number(md[2]), today)
  }
  return null
}

const MONTH_WORD = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?![a-z])\\.?'
const WHOLE_DATE = new RegExp(
  `^(?:(?:the\\s+)?day\\s+before\\s+yesterday|yesterday|today|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}[/.-]\\d{1,2}(?:[/.-](?:\\d{4}|\\d{2}))?|\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?:,?\\s+\\d{4})?|${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)$`,
  'i',
)

/** Like parseReportDate, but only when the whole text is the day ("15/7", "15 July", "yesterday"); else null. */
export function parseWholeDate(text: string, today: string): string | null {
  const value = text.trim().replace(/[.?!]+$/, '').trim()
  return WHOLE_DATE.test(value) ? parseReportDate(value, today) : null
}

const NAMED_DAY = new RegExp(
  [
    '\\b(?:day\\s+before\\s+yesterday|yesterday|today)\\b',
    '\\b\\d{4}-\\d{2}-\\d{2}\\b',
    '(?<![\\d/.-])\\d{1,2}[/-]\\d{1,2}(?:[/-](?:\\d{4}|\\d{2}))?(?![\\d/-])',
    '(?<![\\d.])\\d{1,2}\\.\\d{1,2}\\.(?:\\d{4}|\\d{2})(?![\\d.])',
    `\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?:,?\\s+\\d{4})?`,
    `\\b${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4})?`,
  ].join('|'),
  'i',
)

/**
 * The day a sentence names ("we were 85 on 15/7", "banana 11 t yesterday"), stricter than parseReportDate so that
 * quantities like "11.5 t" or "7/6/6/7" are not read as days; null when it names none.
 */
export function namedDay(text: string, today: string): string | null {
  const match = NAMED_DAY.exec(text)
  return match ? parseReportDate(match[0], today) : null
}

/**
 * The day manpower and gate estimates are for when the message names none: before noon (India time) people report
 * the day before, from noon on the day itself.
 */
export function defaultInputDate(now: Date): string {
  const today = istDay(now)
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hourCycle: 'h23' }).format(now))
  return hour < 12 ? addDays(today, -1) : today
}

/** 2026-07-15 -> "15 Jul 2026" */
export function dayLabel(isoDay: string): string {
  const [y, m, d] = isoDay.split('-').map(Number)
  return `${d} ${MONTHS_SHORT[m! - 1]} ${y}`
}

/** 2026-07-15 -> "15-07-2026", as the sheet prints dates. */
export function ddmmyyyy(isoDay: string): string {
  const [y, m, d] = isoDay.split('-')
  return `${d}-${m}-${y}`
}

// ------------------------------------------------------------------------------------------------ labels

const LEGAL_SUFFIX = /\b(?:private|pvt|limited|ltd|llp|india|enterprises|industries|company|co)\b\.?/gi

/** "Saneesh Agustine" stays; "Pee Tee Cee Banana Private Limited" -> "Pee Tee Cee Banana". */
export function shortPartyName(name: string): string {
  const cleaned = name
    .replace(/\(.*?\)/g, ' ')
    .split(/[,-]/)[0]!
    .replace(LEGAL_SUFFIX, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s.,&]+|[\s.,&]+$/g, '')
  return cleaned || name.trim()
}

function titleCase(words: string): string {
  return words
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(' ')
}

/** The payee or payer a memo names: "Paid to gireesh for electrical work" -> "Gireesh". */
export function memoParty(memo: string | null): string | null {
  if (!memo) return null
  const match = /\b(?:paid\s+to|payment\s+to|payment\s+from|received\s+from|recd\.?\s+from|from)\s+([a-z][a-z.&' ]{1,40}?)(?=\s+(?:for|-|towards|against|on|by|as|in|to|being)\b|[-,.(:;\d]|$)/i.exec(
    memo,
  )
  if (!match) return null
  const name = match[1]!.trim().split(/\s+/).slice(0, 3).join(' ')
  return name.length >= 2 ? titleCase(name) : null
}

export type LabelBook = {
  /** card code -> alias (Mom, Wipro) */
  aliases: Map<string, string>
  /** GL code -> label */
  glLabels: Map<string, GlLabel>
}

export async function loadLabelBook(store: Pick<Store, 'listPartyAliases' | 'listGlLabels'>): Promise<LabelBook> {
  const [aliases, labels] = await Promise.all([store.listPartyAliases(), store.listGlLabels()])
  return { aliases: new Map(aliases.map((row) => [row.cardCode, row.alias])), glLabels: new Map(labels.map((row) => [row.glCode, row])) }
}

/**
 * How the sheet names a bank line: a transfer between own accounts, the party's alias (or short name), the label of
 * the GL account paid (or the payee in the memo when that label says so), the party the memo names, the GL
 * account's own name, else "Unknown".
 */
export function lineLabel(line: Pick<BankLine, 'contraKind' | 'contraBank' | 'cardCode' | 'contraName' | 'contraCode' | 'purposeGl' | 'paymentMemo' | 'memo' | 'jeMemo'>, book: LabelBook): string {
  if (line.contraKind === 'bank' && line.contraBank) return `Transfer ⇄ ${line.contraBank}`
  const memo = line.paymentMemo ?? line.memo ?? line.jeMemo
  if (line.cardCode) return book.aliases.get(line.cardCode) ?? shortPartyName(line.contraName ?? line.cardCode)
  const gl = line.purposeGl ?? line.contraCode
  const label = gl ? book.glLabels.get(gl) : undefined
  if (label) return label.preferPayee ? (memoParty(memo) ?? label.label) : label.label
  return memoParty(memo) ?? tidyAccountName(line.contraName) ?? 'Unknown'
}

// ------------------------------------------------------------------------------------------------ inwards

/** Which of the sheet's item rows a received item belongs to. */
export function inwardKey(line: Pick<InwardLine, 'materialRole' | 'itemName' | 'itemCode'>): InwardKey {
  const name = `${line.itemName ?? ''} ${line.itemCode ?? ''}`.toLowerCase()
  switch (line.materialRole) {
    case 'raw_banana':
      return 'banana'
    case 'raw_cassava':
      return 'cassava'
    case 'oil':
      return 'oil'
    case 'seasoning':
      return 'flavour'
    case 'laminate':
      return 'laminate'
    case 'carton':
    case 'tape':
      return 'packing'
  }
  if (/diesel/.test(name)) return 'diesel'
  if (/\blpg\b|\bgas\b/.test(name)) return 'gas'
  if (/caustic/.test(name)) return 'caustic'
  if (/banana/.test(name) && line.materialRole !== 'fg') return 'banana'
  return 'other'
}

const qtyFormat = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

/** 11000 -> "11 t", 11500 -> "11.5 t", 850 -> "850 kg". */
export function kgText(kg: number): string {
  if (kg >= 1000) return `${qtyFormat.format(Math.round(kg / 100) / 10)} t`
  return `${qtyFormat.format(kg)} kg`
}

function sapQtyText(rows: Array<{ qty: number; uom: string | null }>): string {
  return rows.map((row) => `${qtyFormat.format(row.qty)}${row.uom ? ` ${row.uom}` : ''}`).join(' + ')
}

export function inwardRows(lines: InwardLine[], inputs: DailyReportInputs | null): InwardRow[] {
  return INWARD_ITEMS.flatMap((item): InwardRow[] => {
    const mine = lines.filter((line) => inwardKey(line) === item.key)
    const byUom = new Map<string, number>()
    for (const line of mine) byUom.set(line.uom ?? '', (byUom.get(line.uom ?? '') ?? 0) + line.qty)
    const sapQty = [...byUom.entries()].map(([uom, qty]) => ({ qty: Math.round(qty * 1000) / 1000, uom: uom || null }))
    const estimateKg = item.key === 'banana' ? (inputs?.bananaKgEstimate ?? null) : item.key === 'cassava' ? (inputs?.cassavaKgEstimate ?? null) : null
    const remarks = inputs?.inwardRemarks?.[item.key]?.trim() || null
    if (item.key === 'other' && mine.length === 0 && !remarks) return []
    let quantity: string | null = null
    if (estimateKg != null) quantity = `${kgText(estimateKg)}${sapQty.length ? ` (SAP GRPO ${sapQtyText(sapQty)})` : ' (not in SAP yet)'}`
    else if (sapQty.length) quantity = sapQtyText(sapQty)
    return [
      {
        key: item.key,
        label: item.label,
        quantity,
        sapQty,
        estimateKg,
        remarks,
        grns: [...new Set(mine.map((line) => line.docNo))],
      },
    ]
  })
}

// ------------------------------------------------------------------------------------------------ activity

function activity(input: boolean | null | undefined, sap: boolean, detail: string | null, sapKnown: boolean): ActivityFlag {
  if (input != null) return { value: input, source: 'input', detail }
  if (!sapKnown) return { value: null, source: null, detail: null }
  return { value: sap, source: 'sap', detail }
}

export function activityFlags(day: ProductionDay | null, inputs: DailyReportInputs | null): DailyReportPayload['activity'] {
  const known = day !== null
  const issued = (role: string) => day?.issues.some((row) => row.role === role) ?? false
  const orders = day?.orders ?? []
  const producedQty = day?.receipts.reduce((sum, row) => sum + row.qty, 0) ?? 0
  const productionDetail = day
    ? [
        orders.length ? `${orders.map((order) => order.docNo).join(', ')} posted` : null,
        day.receipts.length ? `${qtyFormat.format(producedQty)} pcs of finished goods received` : null,
      ]
        .filter(Boolean)
        .join('; ') || null
    : null
  return {
    production: activity(inputs?.productionRun, orders.length > 0 || (day?.receipts.length ?? 0) > 0, productionDetail, known),
    packing: activity(inputs?.packingRun, issued('laminate'), issued('laminate') ? 'laminate issued to production' : null, known),
    cartoning: activity(inputs?.cartoningRun, issued('carton'), issued('carton') ? 'cartons issued to production' : null, known),
  }
}

// ------------------------------------------------------------------------------------------------ build

export function manpowerTotal(manpower: Manpower | null): number | null {
  if (!manpower) return null
  return MANPOWER_KEYS.reduce((sum, key) => sum + (Number(manpower[key]) || 0), 0)
}

function lineRef(line: BankLine): string | null {
  if (line.transType === '24') return line.sourceNo ? `RT ${line.sourceNo}` : null
  if (line.transType === '46') return line.sourceNo ? `PA ${line.sourceNo}` : null
  return `JE ${line.transId}`
}

export async function reportSettings(store: Store): Promise<{ basis: OutwardsBasis; cutoff: string; knownDifferences: string[] }> {
  const [basis, cutoff, differences] = await Promise.all([
    store.getSetting(SETTING_BASIS),
    store.getSetting(SETTING_CUTOFF),
    store.getSetting(SETTING_KNOWN_DIFFERENCES),
  ])
  const lines = Array.isArray(differences) ? differences.filter((row): row is string => typeof row === 'string' && row.trim() !== '') : []
  return {
    basis: asOutwardsBasis(basis) ?? DEFAULT_BASIS,
    cutoff: typeof cutoff === 'string' && /^\d{1,2}:\d{2}$/.test(cutoff) ? cutoff : DEFAULT_CUTOFF,
    // a copy: pdfmake replaces list items in place with its layout objects
    knownDifferences: lines.length ? lines : [...GENERIC_DIFFERENCES],
  }
}

function basisNote(basis: OutwardsBasis, date: string, cutoff: string): string {
  if (basis === 'created_window') {
    return `Outwards: invoices keyed in SAP after ${cutoff} on ${ddmmyyyy(addDays(date, -1))} and up to ${cutoff} on ${ddmmyyyy(date)} (the manual sheet's cut-off). Month total: invoices dated this month keyed by then, as on the manual sheet; an invoice dated last month but keyed after ${cutoff} on its last day is in the day total and not in the month total.`
  }
  if (basis === 'ewb_date') {
    return `Outwards: invoices whose e-way bill is dated ${ddmmyyyy(date)} (an invoice without one counts on its own date). Month total: invoices dated this month that had gone out by then.`
  }
  return `Outwards: invoices dated ${ddmmyyyy(date)}. Month total: invoices dated this month up to this day.`
}

function groupOutwards(invoices: Awaited<ReturnType<typeof outwardsFor>>['invoices'], aliases: Map<string, string>): OutwardsRow[] {
  const rows = new Map<string, OutwardsRow>()
  for (const invoice of invoices) {
    const label = aliases.get(invoice.cardCode) ?? shortPartyName(invoice.cardName)
    const row = rows.get(label) ?? { label, amount: 0, invoices: [], cardCodes: [] }
    row.amount = round2(row.amount + invoice.total)
    row.invoices.push(invoice.docNo)
    if (!row.cardCodes.includes(invoice.cardCode)) row.cardCodes.push(invoice.cardCode)
    rows.set(label, row)
  }
  return [...rows.values()]
}

function toReportLine(line: BankLine, book: LabelBook, side: 'in' | 'out'): ReportLine {
  const label = lineLabel(line, book)
  return {
    label: line.isReversal ? `cancelled ${label}` : label,
    bank: line.bank,
    amount: round2(side === 'in' ? line.debit : line.credit),
    ref: lineRef(line),
    memo: line.paymentMemo ?? line.memo,
    transfer: line.contraKind === 'bank',
    movedFrom: line.reportDate !== line.refDate ? line.refDate : null,
  }
}

/**
 * The day's receipts and payments lists, each adding up to its bank column (receipts = Σ debit, payments = Σ credit).
 * A line sits in the list of the column SAP posted it in. SAP cancels a payment with a reversing entry in the same
 * column with negative amounts: when the original and its reversal both count on this day the pair is left out
 * (nothing happened); a reversal on another day stays in its original's column with a negative amount, labelled
 * "cancelled …".
 */
export function reportLines(lines: readonly BankLine[], book: LabelBook): { receipts: ReportLine[]; payments: ReportLine[] } {
  const dropped = new Set<BankLine>()
  for (const reversal of lines) {
    if (reversal.reversesTransId == null) continue
    const original = lines.find(
      (line) =>
        !dropped.has(line) &&
        line.transId === reversal.reversesTransId &&
        line.glCode === reversal.glCode &&
        round2(line.debit + reversal.debit) === 0 &&
        round2(line.credit + reversal.credit) === 0,
    )
    if (!original) continue
    dropped.add(original)
    dropped.add(reversal)
  }
  const kept = lines.filter((line) => !dropped.has(line))
  return {
    receipts: kept.filter((line) => line.debit !== 0).map((line) => toReportLine(line, book, 'in')),
    payments: kept.filter((line) => line.credit !== 0).map((line) => toReportLine(line, book, 'out')),
  }
}

/**
 * Builds one day's report. A day after the SAP data date gives the inputs-only page (manpower, estimates, notes)
 * with "SAP data ends <date>" in place of the SAP blocks.
 */
export async function buildDailyReport(
  deps: ReportDeps,
  input: { date: string; basis?: OutwardsBasis | null },
): Promise<DailyReportPayload> {
  const { sapSql: sql, store } = deps
  const [meta, settings, inputs, aliases, glLabels, moves] = await Promise.all([
    importMeta(sql),
    reportSettings(store),
    store.getDailyInputs(input.date),
    store.listPartyAliases(),
    store.listGlLabels(),
    store.listBankLineReattributions(),
  ])
  const basis = input.basis ?? settings.basis
  const dataAsOf = meta.dataAsOf
  const book: LabelBook = {
    aliases: new Map(aliases.map((row) => [row.cardCode, row.alias])),
    glLabels: new Map(glLabels.map((row) => [row.glCode, row])),
  }
  const manpower = inputs?.manpower ?? null
  const missing = manpower ? [] : ['manpower']
  const base = {
    reportDate: input.date,
    basis,
    cutoff: settings.cutoff,
    dataAsOf,
    generatedAt: deps.now().toISOString(),
    manpower: { values: manpower, total: manpowerTotal(manpower) },
    notes: inputs?.notes ?? null,
    missing,
    knownDifferences: settings.knownDifferences,
  }
  const monthLabel = `${MONTHS_SHORT[Number(input.date.slice(5, 7)) - 1]} ${input.date.slice(0, 4)}`

  if (!dataAsOf || input.date > dataAsOf) {
    return {
      ...base,
      kind: 'inputs_only',
      activity: activityFlags(null, inputs),
      banks: [],
      receipts: [],
      payments: [],
      inwards: inwardRows([], inputs),
      outwards: { rows: [], total: 0, monthToDate: null, monthLabel },
      footnotes: [dataAsOf ? `SAP data ends ${dayLabel(dataAsOf)}: bank, outwards and inwards are not in SAP yet for ${dayLabel(input.date)}.` : 'SAP data has not been imported yet.'],
    }
  }

  const moveRows = moves.map((row: BankLineReattribution) => ({ transId: row.transId, lineId: row.lineId, reportDate: row.reportDate }))
  const [accounts, positions, lines, outwards, grnLines, production] = await Promise.all([
    bankAccounts(sql),
    bankPositions(sql, input.date, moveRows),
    bankLinesOn(sql, input.date, moveRows),
    outwardsFor(sql, { date: input.date, basis, cutoff: settings.cutoff }),
    grnLinesOn(sql, input.date),
    productionOn(sql, input.date),
  ])
  // the report's banks: active bank accounts, plus any other cash account that moved that day
  const moved = new Set(lines.map((line) => line.glCode))
  const shown = accounts.filter((account) => (account.kind === 'bank' && account.active) || moved.has(account.glCode))
  const banks: ReportBank[] = shown.map((account) => {
    const position = positions.find((row) => row.glCode === account.glCode)
    return {
      glCode: account.glCode,
      bank: account.shortName,
      houseBank: account.houseBank,
      opening: position?.opening ?? 0,
      receipts: position?.receipts ?? 0,
      payments: position?.payments ?? 0,
      closing: position?.closing ?? 0,
    }
  })
  const { receipts, payments } = reportLines(lines, book)
  const outwardsRows = groupOutwards(outwards.invoices, book.aliases)
  const footnotes = [
    basisNote(basis, input.date, cutoffTime(settings.cutoff).slice(0, 5)),
    `Bank lines by SAP posting date. SAP data as of ${dayLabel(dataAsOf)}${input.date === dataAsOf ? '; the last day may still be incomplete' : ''}.`,
    ...[...receipts, ...payments]
      .filter((line) => line.movedFrom)
      .map((line) => `* ${line.label} ₹${moneyText(line.amount)} (${line.bank}${line.ref ? `, ${line.ref}` : ''}) is dated ${ddmmyyyy(line.movedFrom!)} in SAP and counted on this day.`),
  ]
  if (!manpower) footnotes.push('Manpower not entered — reply *manpower …* to add.')
  return {
    ...base,
    kind: 'full',
    activity: activityFlags(production, inputs),
    banks,
    receipts,
    payments,
    inwards: inwardRows(grnLines, inputs),
    outwards: {
      rows: outwardsRows,
      total: round2(outwardsRows.reduce((sum, row) => sum + row.amount, 0)),
      monthToDate: outwards.monthToDate,
      monthLabel,
    },
    footnotes,
  }
}

const money = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

export function moneyText(n: number): string {
  return Number.isInteger(n) ? whole.format(n) : money.format(n)
}

/** The WhatsApp caption / summary of a report: bank closings, outwards, manpower, and what is missing. */
export function reportSummary(payload: DailyReportPayload): string {
  const title = `Daily report ${dayLabel(payload.reportDate)}`
  if (payload.kind === 'inputs_only') {
    const lines = [
      `${title}: ${payload.dataAsOf ? `SAP data ends ${dayLabel(payload.dataAsOf)}; sending the inputs-only page.` : 'SAP data is not imported yet; sending the inputs-only page.'}`,
    ]
    lines.push(payload.manpower.total != null ? `Manpower ${payload.manpower.total}.` : 'Manpower not entered — reply *manpower …* to add.')
    return lines.join('\n')
  }
  const closing = payload.banks.map((bank) => `${bank.bank} ₹${moneyText(bank.closing)}`).join(', ')
  const lines = [
    `${title}`,
    `Closing: ${closing}.`,
    `Outwards ₹${moneyText(payload.outwards.total)}${payload.outwards.rows.length ? ` (${payload.outwards.rows.map((row) => `${row.label} ₹${moneyText(row.amount)}`).join(', ')})` : ''}; month to date ₹${moneyText(payload.outwards.monthToDate ?? 0)}.`,
    payload.manpower.total != null ? `Manpower ${payload.manpower.total}.` : 'Manpower not entered — reply *manpower …* to add.',
  ]
  return lines.join('\n')
}

export function basisLabel(basis: OutwardsBasis): string {
  if (basis === 'created_window') return 'invoices keyed by the evening cut-off'
  if (basis === 'ewb_date') return 'by e-way bill date'
  return 'by invoice date'
}

export { OUTWARDS_BASES }

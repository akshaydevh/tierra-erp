import type { Store } from '../db/store'
import type { SalesOrder } from '../db/types'
import { documentsByNo, type DocumentRow } from '../queries/documents'
import { itemsByCode, partiesByCode } from '../queries/masters'
import { isNotImported } from '../queries/meta'
import { knownCustomerPos } from '../queries/sales'
import { financialYear, inScope, type SapSql } from '../sap/db'
import { cardsFor, type Audience } from './scope'

/**
 * The pre-resolver: finds document numbers, customer PO numbers, item codes, card codes and dates in a message with
 * plain regular expressions, checks each against SAP through the same card scope as the tools, and returns what the
 * audience may see. A reference outside the scope is dropped before the prompt is built, so the model never learns
 * that it exists.
 */

export type Ref =
  | { kind: 'document'; text: string; docNo: string; found: DocumentRow | null }
  | { kind: 'tso'; text: string; docNo: string; order: Pick<SalesOrder, 'id' | 'docNo' | 'status' | 'partyName' | 'cardCode' | 'total' | 'customerPoNo'> | null }
  | { kind: 'customer_po'; text: string; customerPoNo: string; cardName: string; soDocNos: string[] }
  | { kind: 'item'; text: string; itemCode: string; itemName: string }
  | { kind: 'card'; text: string; cardCode: string; cardName: string }
  | { kind: 'date'; text: string; date: string }

const FULL_PREFIXES = 'SO|TF|TFC|CN|PR|GR|PO|PL|PV|PA|AP|JE|TSO'
const FULL_DOC = new RegExp(`\\b(${FULL_PREFIXES})\\s*/\\s*(\\d{2})\\s*-\\s*(\\d{2})\\s*/\\s*(\\d{1,7})\\b`, 'gi')
/** SAP's cancellation series: TFC-25/12, CAN-26/3. */
const DASH_DOC = /\b(CAN|TFC)-(\d{2})\/(\d{1,7})\b/gi

/**
 * Short forms people type: "SO 445", "PR#825", "invoice 5586", "GRN 15". Abbreviations count only in capitals, so
 * "so 10 cartons" is not a sales order; the words count in any case.
 */
const NUMBER_TAIL = '\\s*(?:no\\.?|number|#)?\\s*[-:#]?\\s*(\\d{1,6})\\b'
const SHORT_FORMS: Array<[RegExp, string]> = [
  [new RegExp(`\\b(?:SO|[Ss]ales\\s+[Oo]rder)${NUMBER_TAIL}`, 'g'), 'SO'],
  [new RegExp(`\\b(?:TF|INV|[Ii]nvoice)${NUMBER_TAIL}`, 'g'), 'TF'],
  [new RegExp(`\\b(?:PR|[Pp]roduction\\s+[Oo]rder)${NUMBER_TAIL}`, 'g'), 'PR'],
  [new RegExp(`\\b(?:GRN?|GRPO)${NUMBER_TAIL}`, 'g'), 'GR'],
  [new RegExp(`\\b(?:CN|[Cc]redit\\s+[Nn]ote)${NUMBER_TAIL}`, 'g'), 'CN'],
  [new RegExp(`\\b(?:PO|[Pp]urchase\\s+[Oo]rder)${NUMBER_TAIL}`, 'g'), 'PO'],
  [new RegExp(`\\bTSO${NUMBER_TAIL}`, 'g'), 'TSO'],
]

const CUSTOMER_PO = /(?<![\d+])\d{10}(?!\d)/g
/** Tierra's item codes (FG…, TR…) in any case, and other capitalised codes with a digit; SAP confirms each. */
const ITEM_CODE = /\b(?:FG|TR)[A-Z0-9]{3,}\b/gi
const CODE_LIKE = /\b[A-Z][A-Z0-9]{2,}\d[A-Z0-9]*\b/g
const CARD_CODE = /\b[CV]\d{4}\b/gi

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** Real month names and their abbreviations only: "mark", "decrease" or "separate" are not months. */
const MONTH =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\b\\.?'
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+(\\d{4}))?\\b`, 'gi')
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi')
const ISO_DAY = /\b(\d{4})-(\d{2})-(\d{2})\b/g
const DMY = /\b(\d{1,2})[/.](\d{1,2})[/.](\d{4}|\d{2})\b/g

function iso(year: number, month: number, dayOfMonth: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, dayOfMonth))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== dayOfMonth) return null
  return date.toISOString().slice(0, 10)
}

function addDays(isoDay: string, days: number): string {
  return new Date(Date.parse(`${isoDay}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** A day without a year is the latest such day on or before the reference day. */
function withYear(month: number, dayOfMonth: number, year: number | null, reference: string): string | null {
  if (year) return iso(year, month, dayOfMonth)
  const refYear = Number(reference.slice(0, 4))
  const sameYear = iso(refYear, month, dayOfMonth)
  if (sameYear && sameYear <= reference) return sameYear
  return iso(refYear - 1, month, dayOfMonth)
}

/** Today's date in India. */
export function istToday(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(now)
}

/**
 * Dates in a message, as YYYY-MM-DD. "today" and "yesterday" are measured from the SAP data date (questions are
 * about SAP); a day without a year is the latest one on or before it.
 */
export function findDates(text: string, reference: string): Array<{ text: string; date: string }> {
  const found: Array<{ text: string; date: string }> = []
  const push = (raw: string, date: string | null) => {
    if (date && !found.some((row) => row.text === raw)) found.push({ text: raw, date })
  }
  for (const match of text.matchAll(/\bday before yesterday\b/gi)) push(match[0], addDays(reference, -2))
  for (const match of text.matchAll(/\b(?<!before )yesterday\b/gi)) push(match[0], addDays(reference, -1))
  for (const match of text.matchAll(/\btoday\b/gi)) push(match[0], reference)
  for (const match of text.matchAll(ISO_DAY)) push(match[0], iso(Number(match[1]), Number(match[2]), Number(match[3])))
  for (const match of text.matchAll(DMY)) {
    const year = match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3])
    push(match[0], iso(year, Number(match[2]), Number(match[1])))
  }
  for (const match of text.matchAll(DAY_MONTH)) {
    const month = MONTHS.indexOf(match[2]!.slice(0, 3).toLowerCase()) + 1
    push(match[0], withYear(month, Number(match[1]), match[3] ? Number(match[3]) : null, reference))
  }
  for (const match of text.matchAll(MONTH_DAY)) {
    const month = MONTHS.indexOf(match[1]!.slice(0, 3).toLowerCase()) + 1
    push(match[0], withYear(month, Number(match[2]), match[3] ? Number(match[3]) : null, reference))
  }
  return found
}

/** "SO", "26-27", 445 -> SO/26-27/445. Tierra's own TSO numbers keep their four-digit padding: TSO/26-27/0001. */
function docNumber(prefix: string, fy: string, n: number): string {
  const series = prefix.toUpperCase()
  return `${series}/${fy}/${series === 'TSO' ? String(n).padStart(4, '0') : n}`
}

/**
 * A document number as it is printed: SAP's without padding (SO/26-27/445), Tierra's TSO numbers with it
 * (TSO/26-27/0001). "so 445" becomes SO/<financial year of the reference day>/445; a full number is only tidied.
 * Returns null for anything else.
 */
export function normalizeDocNo(raw: string, reference: string): string | null {
  const value = raw.trim()
  const full = new RegExp(`^(${FULL_PREFIXES})\\s*/\\s*(\\d{2})\\s*-\\s*(\\d{2})\\s*/\\s*(\\d{1,7})$`, 'i').exec(value)
  if (full) return docNumber(full[1]!, `${full[2]}-${full[3]}`, Number(full[4]))
  const dash = /^(CAN|TFC)-(\d{2})\/(\d{1,7})$/i.exec(value)
  if (dash) return `${dash[1]!.toUpperCase()}-${dash[2]}/${Number(dash[3])}`
  const short = new RegExp(`^(${FULL_PREFIXES})\\s*[-#:]?\\s*(\\d{1,7})$`, 'i').exec(value)
  if (short) return docNumber(short[1]!, financialYear(reference), Number(short[2]))
  return null
}

export type DocCandidate = { text: string; docNos: string[] }

/** Document numbers in a message; a short form carries the current and the previous financial year to try. */
export function findDocCandidates(text: string, reference: string): DocCandidate[] {
  const out: DocCandidate[] = []
  const seen = new Set<string>()
  const add = (raw: string, docNos: string[]) => {
    const key = docNos.join('|')
    if (seen.has(key)) return
    seen.add(key)
    out.push({ text: raw.trim(), docNos })
  }
  const covered: Array<[number, number]> = []
  for (const match of text.matchAll(FULL_DOC)) {
    add(match[0], [docNumber(match[1]!, `${match[2]}-${match[3]}`, Number(match[4]))])
    covered.push([match.index!, match.index! + match[0].length])
  }
  for (const match of text.matchAll(DASH_DOC)) {
    add(match[0], [`${match[1]!.toUpperCase()}-${match[2]}/${Number(match[3])}`])
    covered.push([match.index!, match.index! + match[0].length])
  }
  const current = financialYear(reference)
  const lastYear = financialYear(addDays(reference, -365))
  for (const [pattern, prefix] of SHORT_FORMS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!
      if (covered.some(([from, to]) => start >= from && start < to)) continue
      const n = Number(match[1])
      add(match[0], [docNumber(prefix, current, n), docNumber(prefix, lastYear, n)])
    }
  }
  return out
}

export type RefDeps = { sapSql: SapSql; store?: Pick<Store, 'findSalesOrderByNo'> }

async function orEmpty<T>(work: Promise<T[]>): Promise<T[]> {
  try {
    return await work
  } catch (error) {
    if (isNotImported(error)) return []
    throw error
  }
}

/**
 * Resolves the references in a message for this audience. Public audiences get dates only; a party gets its own
 * documents, customer PO numbers and cards; internal audiences get everything that exists (and a note for a document
 * number SAP does not have).
 */
export async function resolveRefs(
  deps: RefDeps,
  text: string,
  audience: Audience,
  reference: string,
): Promise<Ref[]> {
  const refs: Ref[] = findDates(text, reference).map((row) => ({ kind: 'date' as const, ...row }))
  if (audience.kind === 'public') return refs
  const cards = cardsFor(audience)
  const internal = audience.kind === 'internal'

  const candidates = findDocCandidates(text, reference)
  const sapCandidates = candidates.filter((candidate) => !candidate.docNos[0]!.startsWith('TSO/'))
  const docs = await orEmpty(
    documentsByNo(
      deps.sapSql,
      cards,
      sapCandidates.flatMap((candidate) => candidate.docNos),
    ),
  )
  for (const candidate of sapCandidates) {
    const found = candidate.docNos.map((docNo) => docs.find((doc) => doc.docNo === docNo)).find(Boolean) ?? null
    if (found) refs.push({ kind: 'document', text: candidate.text, docNo: found.docNo, found })
    else if (internal && candidate.docNos.length === 1) {
      refs.push({ kind: 'document', text: candidate.text, docNo: candidate.docNos[0]!, found: null })
    }
  }
  // Tierra sales orders are internal records: looked up in the app, never shown to a customer group.
  if (internal && deps.store) {
    for (const candidate of candidates.filter((row) => row.docNos[0]!.startsWith('TSO/'))) {
      let order: SalesOrder | null = null
      for (const docNo of candidate.docNos) {
        order = await deps.store.findSalesOrderByNo(docNo)
        if (order) break
      }
      refs.push({ kind: 'tso', text: candidate.text, docNo: order?.docNo ?? candidate.docNos[0]!, order })
    }
  }

  const poNos = [...new Set([...text.matchAll(CUSTOMER_PO)].map((match) => match[0]))]
  for (const po of await orEmpty(knownCustomerPos(deps.sapSql, cards, poNos))) {
    refs.push({ kind: 'customer_po', text: po.customerPoNo, ...po })
  }

  const cardTexts = [...new Set([...text.matchAll(CARD_CODE)].map((match) => match[0]))]
  for (const party of await orEmpty(partiesByCode(deps.sapSql, cardTexts))) {
    if (!inScope(cards, party.cardCode)) continue
    const raw = cardTexts.find((value) => value.toUpperCase() === party.cardCode.toUpperCase()) ?? party.cardCode
    refs.push({ kind: 'card', text: raw, ...party })
  }

  if (internal) {
    const itemTexts = [...new Set([...text.matchAll(ITEM_CODE), ...text.matchAll(CODE_LIKE)].map((match) => match[0]))]
    for (const item of await orEmpty(itemsByCode(deps.sapSql, itemTexts))) {
      const raw = itemTexts.find((value) => value.toUpperCase() === item.itemCode.toUpperCase()) ?? item.itemCode
      refs.push({ kind: 'item', text: raw, ...item })
    }
  }
  return refs
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

/** One line per reference for the prompt. */
export function describeRefs(refs: Ref[]): string[] {
  return refs.map((ref) => {
    switch (ref.kind) {
      case 'document':
        if (!ref.found) {
          return ref.docNo.startsWith('TSO/')
            ? `"${ref.text}" = ${ref.docNo} (a Tierra sales order)`
            : `"${ref.text}" = ${ref.docNo}: not in SAP`
        }
        return `"${ref.text}" = ${ref.found.docNo} (${ref.found.docType.replace(/_/g, ' ')}, ${ref.found.docDate ?? 'no date'}, ${
          ref.found.cardName ?? 'no party'
        }${ref.found.total != null ? `, ₹${inr.format(ref.found.total)}` : ''}${ref.found.cancelled ? ', cancelled' : ''})`
      case 'tso':
        if (!ref.order) return `"${ref.text}" = ${ref.docNo}: no such Tierra sales order`
        return `"${ref.text}" = ${ref.order.docNo} (a Tierra sales order, ${ref.order.status.replace(/_/g, ' ')}, ${
          ref.order.partyName ?? ref.order.cardCode
        }, customer PO ${ref.order.customerPoNo ?? '—'}, ₹${inr.format(ref.order.total)})`
      case 'customer_po':
        return `"${ref.text}" = customer PO ${ref.customerPoNo} of ${ref.cardName} (sales orders ${ref.soDocNos.join(', ')})`
      case 'item':
        return `"${ref.text}" = item ${ref.itemCode} (${ref.itemName})`
      case 'card':
        return `"${ref.text}" = SAP card ${ref.cardCode} (${ref.cardName})`
      case 'date':
        return `"${ref.text}" = ${ref.date}`
    }
  })
}

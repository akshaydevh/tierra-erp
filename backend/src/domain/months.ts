/**
 * Months as people type them ("June", "jun 26", "2026-06", "6/2026", "last month") -> the first day, YYYY-MM-01.
 * A month without a year is the latest one on record (`available`), else the latest on or before the reference day.
 */

const NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
/** A month's name or its usual short form ("jun", "june", "sept"), not any word that starts like one ("marketing"). */
const MONTH_WORD = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?'
const LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

function first(year: number, month: number): string | null {
  if (!Number.isInteger(year) || month < 1 || month > 12 || year < 2000 || year > 2100) return null
  return `${year}-${String(month).padStart(2, '0')}-01`
}

function shift(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  const index = y * 12 + (m - 1) + by
  return first(Math.floor(index / 12), (index % 12) + 1)!
}

function latest(month: number, reference: string, available: readonly string[]): string {
  const mm = String(month).padStart(2, '0')
  const known = available.filter((value) => value.slice(5, 7) === mm).sort().at(-1)
  if (known) return known
  const year = Number(reference.slice(0, 4))
  return month <= Number(reference.slice(5, 7)) ? first(year, month)! : first(year - 1, month)!
}

export function parseMonth(text: string, reference: string, available: readonly string[] = []): string | null {
  const value = text.trim().toLowerCase()
  if (!value) return null
  const current = `${reference.slice(0, 7)}-01`
  if (/\b(?:this|current)\s+month\b/.test(value)) return current
  if (/\b(?:last|previous)\s+month\b/.test(value)) return shift(current, -1)
  const iso = /\b(\d{4})-(\d{1,2})(?:-\d{1,2})?\b/.exec(value)
  if (iso) return first(Number(iso[1]), Number(iso[2]))
  const numeric = /\b(\d{1,2})[/.-](\d{4}|\d{2})\b/.exec(value)
  if (numeric) {
    const year = numeric[2]!.length === 2 ? 2000 + Number(numeric[2]) : Number(numeric[2])
    return first(year, Number(numeric[1]))
  }
  const named = new RegExp(`\\b(${MONTH_WORD})\\.?(?:\\s*['’-]?\\s*(\\d{4}|\\d{2})\\b)?(?![a-z])`).exec(value)
  if (named) {
    const month = NAMES.indexOf(named[1]!.slice(0, 3)) + 1
    if (named[2]) return first(named[2].length === 2 ? 2000 + Number(named[2]) : Number(named[2]), month)
    return latest(month, reference, available)
  }
  return null
}

/** 2026-06-01 -> "June 2026" */
export function monthLabel(month: string): string {
  return `${LONG[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`
}

export function lastDayOf(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number]
  return `${month.slice(0, 8)}${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
}

export function addMonths(month: string, by: number): string {
  return shift(month, by)
}

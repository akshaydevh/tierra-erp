// Display formatters. Indian digit grouping (1,23,456) and lakh/crore short forms
// everywhere; missing values render as an em dash.

const DASH = '—'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LAKH = 1e5
const CRORE = 1e7

type Maybe<T> = T | null | undefined

function isNum(n: Maybe<number>): n is number {
  return typeof n === 'number' && Number.isFinite(n)
}

function grouped(n: number, minDigits: number, maxDigits: number): string {
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: minDigits,
    maximumFractionDigits: maxDigits,
  }).format(n)
}

/** A plain count or amount with Indian grouping: 1234 → "1,234". */
export function num(n: Maybe<number>, maxDigits = 0): string {
  return isNum(n) ? grouped(n, 0, maxDigits) : DASH
}

/** Rupees, whole: 123456 → "₹1,23,456"; -1234 → "-₹1,234". Pass digits=2 for rates. */
export function inr(n: Maybe<number>, digits = 0): string {
  if (!isNum(n)) return DASH
  const sign = n < 0 ? '-' : ''
  return `${sign}₹${grouped(Math.abs(n), digits, digits)}`
}

/** A unit rate: whole rupees stay whole (₹80), paise show two places (₹12.34). */
export function rate(n: Maybe<number>): string {
  if (!isNum(n)) return DASH
  return inr(n, Number.isInteger(n) ? 0 : 2)
}

function trimmed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.?0+$/, '')
}

/** Rupees, short: 12345 → "₹12,345"; 123456 → "₹1.2L"; 12300000 → "₹1.23 cr". */
export function inrShort(n: Maybe<number>): string {
  if (!isNum(n)) return DASH
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  // 99,99,999 rounds to 100.0 lakh; show it as a crore instead.
  if (abs >= CRORE || abs / LAKH >= 99.95) return `${sign}₹${trimmed(abs / CRORE, 2)} cr`
  if (abs >= LAKH) return `${sign}₹${trimmed(abs / LAKH, 1)}L`
  return `${sign}₹${grouped(abs, 0, 0)}`
}

/**
 * A quantity with an optional unit: (1234, 'pcs') → "1,234 pcs"; (12.5, 'kg') → "12.50 kg".
 * Fractions keep two to three places so weights read like the ledger.
 */
export function qty(n: Maybe<number>, uom?: string | null): string {
  if (!isNum(n)) return DASH
  const text = Number.isInteger(n) ? grouped(n, 0, 0) : grouped(n, 2, 3)
  return uom ? `${text} ${uom}` : text
}

type Parts = { y: number; m: number; d: number }

const IST = 'Asia/Kolkata'

function parts(iso: string): Parts | null {
  // A bare date is a calendar day; never shift it through a time zone.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (plain) return { y: Number(plain[1]), m: Number(plain[2]), d: Number(plain[3]) }
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return null
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: IST, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at)
    .split('-')
    .map(Number)
  return { y, m, d }
}

/** "2026-07-23" → "23 Jul 2026". Timestamps are read in India time. */
export function day(iso: Maybe<string>): string {
  const p = iso ? parts(iso) : null
  return p ? `${p.d} ${MONTHS[p.m - 1]} ${p.y}` : DASH
}

/** "2026-07-23" → "23 Jul". */
export function dayShort(iso: Maybe<string>): string {
  const p = iso ? parts(iso) : null
  return p ? `${p.d} ${MONTHS[p.m - 1]}` : DASH
}

/** Time of day in India time: "2026-07-23T11:48:27Z" → "17:18". */
export function time(iso: Maybe<string>): string {
  if (!iso) return DASH
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return DASH
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(at)
}

/** "23 Jul 2026, 17:18" in India time. */
export function dayTime(iso: Maybe<string>): string {
  return iso ? `${day(iso)}, ${time(iso)}` : DASH
}

/** Shift a YYYY-MM-DD calendar day by whole days. */
export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  const at = new Date(Date.UTC(y, m - 1, d + days))
  return at.toISOString().slice(0, 10)
}

export function isIsoDay(value: Maybe<string>): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  return addDays(value, 0) === value
}

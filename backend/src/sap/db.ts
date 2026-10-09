import type postgres from 'postgres'

/**
 * The raw postgres-js client the SAP read model goes through. It is the app's own connection: the
 * `sap` and `erp` schemas live in the same database. Queries read the `erp` views only, never `sap.*`.
 */
export type SapSql = postgres.Sql

export const MAX_PAGE_SIZE = 100
export const DEFAULT_PAGE_SIZE = 50
/** No list here is a million rows long; a larger page number is clamped so OFFSET stays a safe integer. */
export const MAX_PAGE = 10_000

export type Paged<T> = {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export type PageRequest = { page: number; pageSize: number; offset: number }

/**
 * Page numbers start at 1; anything odd falls back to the first page and anything past MAX_PAGE is
 * MAX_PAGE (an empty page). pageSize is capped at 100.
 */
export function pageRequest(page?: string | number | null, pageSize?: string | number | null): PageRequest {
  const asked = Number(page)
  const at = Number.isInteger(asked) && asked > 1 ? Math.min(asked, MAX_PAGE) : 1
  const size = Number(pageSize)
  const per = Number.isInteger(size) && size > 0 ? Math.min(size, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE
  return { page: at, pageSize: per, offset: (at - 1) * per }
}

/** postgres-js returns numeric and bigint as strings. */
export function num(value: unknown): number {
  if (value == null) return 0
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

export function numOrNull(value: unknown): number | null {
  return value == null ? null : num(value)
}

/** A SQL date as YYYY-MM-DD. postgres-js parses `date` into a Date at UTC midnight. */
export function day(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return String(value).slice(0, 10)
}

export function timestamp(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

export function text(value: unknown): string | null {
  return value == null ? null : String(value)
}

/** Text typed into a search box, as an ILIKE pattern ("%foo%"), or null for no search. */
export function searchPattern(q: string | null | undefined): string | null {
  const trimmed = q?.trim()
  if (!trimmed) return null
  return `%${trimmed.replace(/[\\%_]/g, (match) => `\\${match}`)}%`
}

export function isIsoDay(value: string | null | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** First day of the month a YYYY-MM-DD falls in. */
export function monthStart(isoDay: string): string {
  return `${isoDay.slice(0, 7)}-01`
}

/**
 * Which SAP business-partner cards a read may return. 'all' is for Tierra's own people; a list is a customer's
 * party scope, and every party-safe query adds `card_code = any(list)` (an empty list matches nothing).
 */
export type CardScope = 'all' | readonly string[]

/** `and <column> = any(<cards>)` for a party scope, nothing for 'all'. */
export function cardFilter(sql: SapSql, cards: CardScope, column = 'card_code') {
  if (cards === 'all') return sql``
  return sql`and ${sql(column)} = any(${textArray(cards)}::text[])`
}

/**
 * A Postgres array literal for a text[] parameter: '{"a","b"}'. Passed as text and cast in SQL, because postgres-js
 * only serialises JS arrays once it has fetched the array types, which the first query of a connection races.
 */
export function textArray(values: readonly string[]): string {
  return `{${values.map((value) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`
}

/** A Postgres array literal for an integer[] parameter. */
export function intArray(values: readonly number[]): string {
  return `{${values.filter((value) => Number.isSafeInteger(value)).join(',')}}`
}

export function inScope(cards: CardScope, cardCode: string | null | undefined): boolean {
  return cards === 'all' || (cardCode != null && cards.includes(cardCode))
}

/** The financial year a day falls in, as SAP's series spell it: 2026-07-23 -> 26-27, 2026-03-31 -> 25-26. */
export function financialYear(isoDay: string): string {
  const year = Number(isoDay.slice(0, 4))
  const start = Number(isoDay.slice(5, 7)) >= 4 ? year : year - 1
  const two = (n: number) => String(n % 100).padStart(2, '0')
  return `${two(start)}-${two(start + 1)}`
}

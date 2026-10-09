// URL search-param helpers for server-rendered tabs, chips, search and paging.

export type SearchParams = Promise<Record<string, string | string[] | undefined>>

/** The page's current filters, one string per key; undefined means "not set". */
export type Query = Record<string, string | undefined>

export function first(value: string | string[] | undefined): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value
  const trimmed = raw?.trim()
  return trimmed ? trimmed : undefined
}

export function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function pageOf(value: string | undefined): number {
  const page = Number(value)
  return Number.isInteger(page) && page > 1 ? page : 1
}

/** Build `path?query` from the current query with some keys changed; empty values drop out. */
export function hrefFor(path: string, query: Query, patch: Query = {}): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries({ ...query, ...patch })) {
    if (value !== undefined && value !== '') params.set(key, value)
  }
  const text = params.toString()
  return text ? `${path}?${text}` : path
}

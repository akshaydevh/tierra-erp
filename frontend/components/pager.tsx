import Link from 'next/link'
import { num } from '@/lib/format'
import { hrefFor, type Query } from '@/lib/query'

export function Pager({
  page,
  pageSize,
  total,
  path,
  query,
  noun = 'rows',
}: {
  page: number
  pageSize: number
  total: number
  path: string
  query: Query
  noun?: string
}) {
  if (total === 0) return null
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  const at = (target: number) => hrefFor(path, query, { page: target > 1 ? String(target) : undefined })
  return (
    <nav className="pager" aria-label="Pages">
      <span className="stamp">
        {from > total ? `Past the last page · ${num(total)} ${noun}` : `${num(from)}–${num(to)} of ${num(total)} ${noun}`}
      </span>
      {pages > 1 ? (
        <span className="actions">
          {page > 1 ? (
            <Link className="btn-sec" href={at(Math.min(page - 1, pages))} rel="prev">
              Previous
            </Link>
          ) : (
            <span className="btn-sec" aria-disabled="true">
              Previous
            </span>
          )}
          <span className="stamp">
            Page {num(page)} of {num(pages)}
          </span>
          {page < pages ? (
            <Link className="btn-sec" href={at(page + 1)} rel="next">
              Next
            </Link>
          ) : (
            <span className="btn-sec" aria-disabled="true">
              Next
            </span>
          )}
        </span>
      ) : null}
    </nav>
  )
}

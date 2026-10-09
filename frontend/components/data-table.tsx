import Link from 'next/link'
import type { ReactNode } from 'react'

export type Column<T> = {
  key: string
  label: string
  /** Right-aligned, tabular, never wraps. Implies align 'right'. */
  num?: boolean
  align?: 'left' | 'right'
  /** Keep on one line (document numbers, dates). */
  nowrap?: boolean
  /** Cell content; defaults to `row[key]`. */
  render?: (row: T) => ReactNode
  /** A muted second line under the cell content. */
  sub?: (row: T) => ReactNode
  /** Extra class on the cell, e.g. a warning tone for negative values. */
  tone?: (row: T) => string | undefined
}

type Props<T> = {
  /** Read by screen readers; describes what the table lists. */
  caption: string
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  /** Makes the first column a link to the row's record. */
  rowHref?: (row: T) => string
  /** Shown instead of the table when there are no rows. */
  empty?: ReactNode
  /** A footer row keyed by column; the first column gets `totalLabel` when it has no entry. */
  total?: Partial<Record<string, ReactNode>>
  totalLabel?: string
}

function cellClass<T>(column: Column<T>, row?: T): string | undefined {
  const names = [
    column.num || column.align === 'right' ? 'r' : '',
    column.num ? 'num' : '',
    column.nowrap ? 'nw' : '',
    row && column.tone ? (column.tone(row) ?? '') : '',
  ].filter(Boolean)
  return names.length ? names.join(' ') : undefined
}

function plain<T>(row: T, key: string): ReactNode {
  const value = (row as Record<string, unknown>)[key]
  if (value === null || value === undefined || value === '') return '—'
  return String(value)
}

export function DataTable<T>({ caption, columns, rows, rowKey, rowHref, empty, total, totalLabel = 'Total' }: Props<T>) {
  if (rows.length === 0) {
    return <div className="card empty">{empty ?? <p>Nothing to show.</p>}</div>
  }
  // Wide enough that ten columns still read at 1280px; narrower screens scroll inside the card.
  const minWidth = Math.max(560, columns.length * 92)
  return (
    <div className="tblwrap">
      <table className="dt" style={{ minWidth }}>
        <caption className="sr">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={cellClass(column)}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((column, index) => {
                const content = column.render ? column.render(row) : plain(row, column.key)
                const sub = column.sub?.(row)
                return (
                  <td key={column.key} className={cellClass(column, row)}>
                    {index === 0 && rowHref ? (
                      <Link href={rowHref(row)}>
                        <b>{content}</b>
                      </Link>
                    ) : (
                      content
                    )}
                    {sub !== undefined && sub !== null && sub !== '' ? <div className="sub">{sub}</div> : null}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
        {total ? (
          <tfoot>
            <tr>
              {columns.map((column, index) => (
                <td key={column.key} className={cellClass(column)}>
                  {total[column.key] ?? (index === 0 ? totalLabel : null)}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}

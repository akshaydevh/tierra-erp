import type { ReactNode } from 'react'
import { DataTable, type Column } from './data-table'
import { StatusPill } from './status-pill'
import { day, inr, num, qty } from '@/lib/format'
import type { SalesOrderRow } from '@/lib/types'

const columns: Column<SalesOrderRow>[] = [
  { key: 'docNo', label: 'Sales order', nowrap: true, render: (row) => row.docNo, sub: (row) => day(row.docDate) },
  {
    key: 'cardName',
    label: 'Customer',
    render: (row) => row.cardName,
    sub: (row) => (row.customerPoNo ? `PO ${row.customerPoNo}` : 'No customer PO'),
  },
  { key: 'dueDate', label: 'Due', nowrap: true, render: (row) => day(row.dueDate) },
  { key: 'lineCount', label: 'Lines', num: true, render: (row) => num(row.lineCount), sub: (row) => `${qty(row.totalQty)} ordered` },
  { key: 'invoiceCount', label: 'Invoices', num: true, render: (row) => num(row.invoiceCount) },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total), tone: (row) => (row.total < 0 ? 'neg' : undefined) },
  {
    key: 'status',
    label: 'Status',
    render: (row) => (
      <span className="pills">
        <StatusPill status={row.status} />
        {row.stale && row.status === 'open' ? <StatusPill status="stale" label="Over 90 days" /> : null}
      </span>
    ),
  },
]

/** Sales orders as the order book and the Command Centre list them; rows open the order. */
export function SalesOrderTable({ rows, caption, empty }: { rows: SalesOrderRow[]; caption: string; empty: ReactNode }) {
  return (
    <DataTable
      caption={caption}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.docEntry}
      rowHref={(row) => `/orders/so/${row.docEntry}`}
      empty={empty}
    />
  )
}

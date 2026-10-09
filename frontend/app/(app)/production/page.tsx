import Link from 'next/link'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { SearchBox } from '@/components/search-box'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { FilterChips } from '@/components/tabs'
import { api, getMeta } from '@/lib/api'
import { day, inr, num, qty } from '@/lib/format'
import { first, hrefFor, pageOf, type Query, type SearchParams } from '@/lib/query'
import { PRODUCTION_STATUSES, type ProductionResponse, type ProductionRow, type ProductionStatus } from '@/lib/types'

const PATH = '/production'

const STATUS_LABELS: Record<ProductionStatus, string> = {
  planned: 'Planned',
  released: 'Released',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

const columns: Column<ProductionRow>[] = [
  { key: 'docNo', label: 'Work order', nowrap: true },
  { key: 'itemCode', label: 'SKU', sub: (row) => row.itemName },
  { key: 'customerName', label: 'Customer' },
  { key: 'type', label: 'Type', render: (row) => <StatusPill status={row.type} /> },
  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
  { key: 'plannedQty', label: 'Planned', num: true, render: (row) => qty(row.plannedQty) },
  {
    key: 'completedQty',
    label: 'Completed',
    num: true,
    render: (row) => qty(row.completedQty),
    tone: (row) => (row.status === 'closed' && row.completedQty < row.plannedQty ? 'warn' : undefined),
  },
  { key: 'postDate', label: 'Posted', nowrap: true, render: (row) => day(row.postDate) },
  {
    key: 'issuedValue',
    label: 'Issued ₹',
    num: true,
    render: (row) => inr(row.issuedValue),
    tone: (row) => ((row.issuedValue ?? 0) < 0 ? 'neg' : undefined),
  },
  {
    key: 'receivedValue',
    label: 'Received ₹',
    num: true,
    render: (row) => inr(row.receivedValue),
    tone: (row) => ((row.receivedValue ?? 0) < 0 ? 'neg' : undefined),
  },
]

export default async function ProductionPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const statusParam = first(params.status)
  const status = PRODUCTION_STATUSES.includes(statusParam as ProductionStatus) ? (statusParam as ProductionStatus) : undefined
  const q = first(params.q)
  const page = pageOf(first(params.page))
  const query: Query = { status, q, page: page > 1 ? String(page) : undefined }

  const meta = await getMeta()
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <NotImported what="Production orders and what they consumed" />
      </>
    )
  }
  const data = await api<ProductionResponse>(hrefFor('/api/production', { status, q, page: String(page) }))
  const { kpis } = data

  return (
    <>
      <DataAsOf meta={meta} />
      <KpiStrip label="Production in figures">
        <Kpi chip="WO" label="Open work orders" value={num(kpis.openOrders)} stamp="Planned or released, not yet closed" />
        <Kpi chip="✓" tone="leaf" label="Completed this month" value={qty(kpis.completedMtdQty)} stamp="Quantity received from production" />
        <Kpi chip="MTD" label="Work orders this month" value={num(kpis.ordersMtd)} stamp="Posted since the 1st" />
        <Kpi chip="D" tone="amber" label="Disassembly this month" value={num(kpis.disassemblyMtd)} stamp="Finished goods broken back down" />
      </KpiStrip>
      <section className="sec" aria-labelledby="prod-head">
        <SectionHead
          id="prod-head"
          title="Work orders"
          sub="SAP production orders, newest first. Issued is the material drawn; received is the value of what came off the line."
          zid="Zone 1 · Make"
        />
        <div className="toolbar">
          <FilterChips
            label="Work order status"
            param="status"
            path={PATH}
            query={query}
            active={status ?? ''}
            options={[
              { key: '', label: 'All' },
              ...PRODUCTION_STATUSES.map((key) => ({ key, label: STATUS_LABELS[key] })),
            ]}
          />
          <SearchBox path={PATH} query={query} label="Search work orders" placeholder="Work order, SKU or customer" />
        </div>
        <DataTable
          caption="Production work orders"
          columns={columns}
          rows={data.rows}
          rowKey={(row) => row.docEntry}
          rowHref={(row) => `/production/${row.docEntry}`}
          empty={
            q || status ? (
              <p>
                Nothing matches these filters. <Link href={PATH}>Clear the filters</Link>
              </p>
            ) : (
              <p>No production orders in SAP yet.</p>
            )
          }
        />
        <Pager page={data.page} pageSize={data.pageSize} total={data.total} path={PATH} query={query} noun="work orders" />
      </section>
    </>
  )
}

import Link from 'next/link'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { SalesOrderTable } from '@/components/sales-order-table'
import { SearchBox } from '@/components/search-box'
import { SectionHead } from '@/components/section-head'
import { FilterChips, Tabs } from '@/components/tabs'
import { api, getMeta } from '@/lib/api'
import { day, dayTime, inr, inrShort, num } from '@/lib/format'
import { first, hrefFor, oneOf, pageOf, type Query, type SearchParams } from '@/lib/query'
import { StatusPill } from '@/components/status-pill'
import {
  ORDER_STATES,
  ORDER_TABS,
  type CustomerPoRow,
  type CustomerPoSummary,
  type CustomerPosResponse,
  type OrderBookResponse,
  type OrdersKpis,
  type TsoSummary,
} from '@/lib/types'

const PATH = '/orders'

const STATE_LABELS = { all: 'All', open: 'Open', closed: 'Closed', cancelled: 'Cancelled' } as const

const poColumns: Column<CustomerPoRow>[] = [
  { key: 'customerPoNo', label: 'Customer PO', nowrap: true, sub: (row) => `${day(row.firstDate)} – ${day(row.lastDate)}` },
  { key: 'cardName', label: 'Customer', sub: (row) => row.cardCodes.join(', ') },
  { key: 'salesOrderCount', label: 'Sales orders', num: true, render: (row) => num(row.salesOrderCount) },
  {
    key: 'openCount',
    label: 'Still open',
    num: true,
    render: (row) => num(row.openCount),
    tone: (row) => (row.openCount > 0 ? 'warn' : undefined),
  },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total), tone: (row) => (row.total < 0 ? 'neg' : undefined) },
]

const TAB_OPTIONS = [
  { key: 'book', label: 'Order book' },
  { key: 'customer-pos', label: 'Customer POs' },
  { key: 'intake', label: 'Intake' },
  { key: 'tso', label: 'Tierra SOs' },
]

function source(row: CustomerPoSummary): string {
  if (!row.sourceChat) return 'Unknown'
  if (row.sourceChat.startsWith('desk:')) return 'Desk'
  if (row.sourceChat.endsWith('@g.us')) return 'WhatsApp group'
  return 'WhatsApp'
}

const intakeColumns: Column<CustomerPoSummary>[] = [
  {
    key: 'poNo',
    label: 'Customer PO',
    nowrap: true,
    render: (row) => `${row.poNo ?? 'No number'}${row.revision > 1 ? ` (r${row.revision})` : ''}`,
    sub: (row) => (row.poDate ? `PO date ${day(row.poDate)}` : undefined),
  },
  {
    key: 'partyName',
    label: 'Customer',
    render: (row) => row.partyName ?? row.cardCode ?? 'Not resolved',
    sub: (row) => [row.cardCode, row.siteCode ? `site ${row.siteCode}` : null].filter(Boolean).join(' · ') || undefined,
  },
  { key: 'deliveryDate', label: 'Delivery', nowrap: true, render: (row) => day(row.deliveryDate) },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total, 2) },
  {
    key: 'verdict',
    label: 'Check',
    render: (row) => (row.verdict ? <StatusPill status={row.verdict} /> : <span className="stamp">Not checked</span>),
  },
  {
    key: 'status',
    label: 'Status',
    render: (row) => <StatusPill status={row.status} />,
    sub: (row) => (row.status === 'needs_review' && row.reviewReason ? row.reviewReason.slice(0, 90) : undefined),
  },
  { key: 'createdAt', label: 'Received', nowrap: true, render: (row) => dayTime(row.createdAt), sub: source },
]

async function IntakeTab({ query }: { query: Query }) {
  const { rows } = await api<{ rows: CustomerPoSummary[] }>('/api/customer-pos')
  return (
    <section className="sec" aria-labelledby="intake-head">
      <SectionHead
        id="intake-head"
        title="Intake"
        sub="Customer purchase orders received on WhatsApp or the desk, with the customer, the lines and the stock and BOM check. Newest first."
        zid="Zone 1 · Intake"
      />
      <div className="toolbar">
        <Tabs label="Order views" param="tab" path={PATH} query={query} reset={{ po: undefined, party: undefined, state: undefined, q: undefined }} active="intake" options={TAB_OPTIONS} />
      </div>
      <DataTable
        caption="Customer purchase orders received"
        columns={intakeColumns}
        rows={rows}
        rowKey={(row) => row.id}
        rowHref={(row) => `/orders/po/${row.id}`}
        empty={<p>No purchase orders received yet. Forward a PO PDF to Tierra Bot, or attach one on the agent desk.</p>}
      />
    </section>
  )
}

const tsoColumns: Column<TsoSummary>[] = [
  {
    key: 'docNo',
    label: 'Tierra SO',
    nowrap: true,
    sub: (row) => (row.version > 1 ? `version ${row.version}` : undefined),
  },
  { key: 'partyName', label: 'Customer', render: (row) => row.partyName ?? row.cardCode, sub: (row) => row.cardCode },
  {
    key: 'customerPoNo',
    label: 'Customer PO',
    nowrap: true,
    render: (row) =>
      row.customerPoNo && row.customerPoId ? (
        <Link href={`/orders/po/${encodeURIComponent(row.customerPoId)}`}>{row.customerPoNo}</Link>
      ) : (
        (row.customerPoNo ?? '—')
      ),
  },
  { key: 'docDate', label: 'Date', nowrap: true, render: (row) => day(row.docDate) },
  { key: 'deliveryDate', label: 'Delivery', nowrap: true, render: (row) => day(row.deliveryDate) },
  { key: 'pcs', label: 'Pieces', num: true, render: (row) => num(row.pcs), sub: (row) => `${num(row.lineCount)} ${row.lineCount === 1 ? 'line' : 'lines'}` },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total, 2) },
  {
    key: 'status',
    label: 'Status',
    render: (row) => <StatusPill status={row.status} />,
    sub: (row) => (row.sentAt ? `Sent ${dayTime(row.sentAt)}` : row.approvedAt ? `Approved ${dayTime(row.approvedAt)}` : undefined),
  },
]

async function TsoTab({ query }: { query: Query }) {
  const { rows } = await api<{ rows: TsoSummary[] }>('/api/sales-orders')
  return (
    <section className="sec" aria-labelledby="tso-head">
      <SectionHead
        id="tso-head"
        title="Tierra SOs"
        sub="Sales orders Tierra raised from checked customer POs, newest first. Each waits for the admin’s approval before the customer copy goes to the customer’s group."
        zid="Zone 1 · Tierra SOs"
      />
      <div className="toolbar">
        <Tabs label="Order views" param="tab" path={PATH} query={query} reset={{ po: undefined, party: undefined, state: undefined, q: undefined }} active="tso" options={TAB_OPTIONS} />
      </div>
      <DataTable
        caption="Tierra sales orders"
        columns={tsoColumns}
        rows={rows}
        rowKey={(row) => row.id}
        rowHref={(row) => `/orders/tso/${encodeURIComponent(row.id)}`}
        empty={<p>No Tierra sales orders yet. One is raised when a received PO passes its check.</p>}
      />
    </section>
  )
}

function Kpis({ kpis }: { kpis: OrdersKpis }) {
  return (
    <KpiStrip label="Orders in figures">
      <Kpi chip="SO" label="Open sales orders" value={num(kpis.open)} stamp="Not yet fully invoiced or closed" />
      <Kpi
        chip="90"
        tone="amber"
        label="Open over 90 days"
        value={num(kpis.stale)}
        stamp="Dated more than 90 days before the data date"
        attn={kpis.stale > 0}
      />
      <Kpi chip="₹" tone="leaf" label="Ordered this month" value={inrShort(kpis.valueMtd)} stamp="Sales order value, month to date" />
      <Kpi chip="PO" label="Customer POs" value={num(kpis.poCount)} stamp="Distinct purchase orders, per customer" />
    </KpiStrip>
  )
}

export default async function OrdersPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const tab = oneOf(first(params.tab), ORDER_TABS, 'book')
  const state = oneOf(first(params.state), ORDER_STATES, 'all')
  const q = first(params.q)
  // One customer PO (number + who sent it), opened from the Customer POs tab; book only.
  const po = tab === 'book' ? first(params.po) : undefined
  const party = po ? first(params.party) : undefined
  const page = pageOf(first(params.page))
  const query: Query = {
    tab: tab === 'book' ? undefined : tab,
    state: state === 'all' ? undefined : state,
    q,
    po,
    party,
    page: page > 1 ? String(page) : undefined,
  }

  if (tab === 'intake') return <IntakeTab query={{ tab }} />
  if (tab === 'tso') return <TsoTab query={{ tab }} />

  const meta = await getMeta()
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <NotImported what="Sales orders and customer purchase orders" />
      </>
    )
  }
  const apiPath = hrefFor('/api/orders', { tab, state, q, po, party, page: String(page) })
  const data = tab === 'book' ? await api<OrderBookResponse>(apiPath) : await api<CustomerPosResponse>(apiPath)
  const filtered = Boolean(q || po || state !== 'all')
  const empty = filtered ? (
    <p>
      Nothing matches these filters. <Link href={hrefFor(PATH, { tab: query.tab })}>Clear the filters</Link>
    </p>
  ) : (
    <p>No sales orders in SAP yet.</p>
  )

  return (
    <>
      <DataAsOf meta={meta} />
      <Kpis kpis={data.kpis} />
      <section className="sec" aria-labelledby="orders-head">
        <SectionHead
          id="orders-head"
          title={tab === 'book' ? 'Order book' : 'Customer POs'}
          sub={
            po ? (
              <>
                Sales orders on customer PO {po}.{' '}
                <Link href={hrefFor(PATH, query, { po: undefined, party: undefined, page: undefined })}>Show every order</Link>
              </>
            ) : tab === 'book' ? (
              'Every sales order in SAP, newest first. Open one for its lines, invoices and approvals.'
            ) : (
              'Sales orders grouped by the customer’s purchase-order number. One PO is often called off over several orders.'
            )
          }
          zid="Zone 1 · Book"
        />
        <div className="toolbar">
          <Tabs
            label="Order views"
            param="tab"
            path={PATH}
            query={query}
            reset={{ po: undefined, party: undefined }}
            active={tab}
            options={TAB_OPTIONS}
          />
          <SearchBox
            path={PATH}
            query={query}
            label={tab === 'book' ? 'Search sales orders' : 'Search customer POs'}
            placeholder="Order, customer or PO number"
          />
        </div>
        <FilterChips
          label="Order state"
          param="state"
          path={PATH}
          query={query}
          active={state}
          options={ORDER_STATES.map((key) => ({
            key,
            label: STATE_LABELS[key],
            count: key === 'open' && tab === 'book' && !q && !po ? data.kpis.open : undefined,
          }))}
        />
        {tab === 'book' ? (
          <SalesOrderTable caption="Sales orders" rows={(data as OrderBookResponse).rows} empty={empty} />
        ) : (
          <DataTable
            caption="Customer purchase orders"
            columns={poColumns}
            rows={(data as CustomerPosResponse).rows}
            rowKey={(row) => `${row.customerPoNo}·${row.partyKey}`}
            rowHref={(row) => hrefFor(PATH, { tab: 'book', po: row.customerPoNo, party: row.partyKey })}
            empty={empty}
          />
        )}
        <Pager
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          path={PATH}
          query={query}
          noun={tab === 'book' ? 'sales orders' : 'customer POs'}
        />
      </section>
    </>
  )
}

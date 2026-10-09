import Link from 'next/link'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { DocList } from '@/components/doc-list'
import { SearchBox } from '@/components/search-box'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { Tabs } from '@/components/tabs'
import { api, documentFiles, getMeta } from '@/lib/api'
import { CancelReceiptButton } from '@/components/record-actions'
import { ReceiptForm } from './receipt-form'
import { day, dayTime, inr, inrShort, num, qty } from '@/lib/format'
import { first, hrefFor, oneOf, pageOf, type Query, type SearchParams } from '@/lib/query'
import {
  PROCUREMENT_TABS,
  type DocFile,
  type GrnRow,
  type GrnsResponse,
  type Meta,
  type ProcurementKpis,
  type ProcurementRequestRow,
  type ProcurementRequestsResponse,
  type PurchaseOrderRow,
  type PurchaseOrdersResponse,
  type StockAdjustment,
  type StockAdjustmentsResponse,
} from '@/lib/types'

const PATH = '/procurement'

const poColumns: Column<PurchaseOrderRow & { files?: DocFile[] }>[] = [
  { key: 'docNo', label: 'Purchase order', nowrap: true, sub: (row) => day(row.docDate) },
  { key: 'cardName', label: 'Vendor' },
  { key: 'lineSummary', label: 'What is on it' },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total), tone: (row) => (row.total < 0 ? 'neg' : undefined) },
  {
    key: 'openValue',
    label: 'Still to come',
    num: true,
    render: (row) => inr(row.openValue),
    tone: (row) => (row.openValue < 0 ? 'neg' : undefined),
  },
  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
  { key: 'files', label: 'Docs', render: (row) => <DocList files={row.files} compact /> },
]

const grnColumns: Column<GrnRow & { files?: DocFile[] }>[] = [
  { key: 'docNo', label: 'Goods receipt', nowrap: true, sub: (row) => day(row.docDate) },
  { key: 'cardName', label: 'Vendor' },
  { key: 'lineSummary', label: 'What came in' },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total), tone: (row) => (row.total < 0 ? 'neg' : undefined) },
  {
    key: 'freeIssue',
    label: 'Free issue',
    render: (row) => (row.freeIssue ? <span className="pill amber">Free issue</span> : <span className="muted">No</span>),
  },
  { key: 'files', label: 'Docs', render: (row) => <DocList files={row.files} compact /> },
]

const TAB_OPTIONS = [
  { key: 'pos', label: 'Purchase orders' },
  { key: 'grns', label: 'Goods receipts' },
  { key: 'requests', label: 'Requests' },
  { key: 'adjustments', label: 'Unposted receipts' },
]

const VIA_LABEL: Record<string, string> = { dashboard: 'Dashboard', whatsapp: 'WhatsApp', desk: 'Agent desk', system: 'Tierra' }

const requestColumns: Column<ProcurementRequestRow>[] = [
  { key: 'itemCode', label: 'Item', nowrap: true, sub: (row) => row.itemName ?? undefined },
  { key: 'qty', label: 'Quantity', num: true, render: (row) => qty(row.qty, row.uom) },
  { key: 'reason', label: 'Why', render: (row) => <StatusPill status={row.reason} />, sub: (row) => row.note ?? undefined },
  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
  {
    key: 'for',
    label: 'For',
    nowrap: true,
    render: (row) =>
      row.salesOrderId && row.docNo ? (
        <Link href={`/orders/tso/${encodeURIComponent(row.salesOrderId)}`}>{row.docNo}</Link>
      ) : row.customerPoId && row.poNo ? (
        <Link href={`/orders/po/${encodeURIComponent(row.customerPoId)}`}>PO {row.poNo}</Link>
      ) : (
        (row.docNo ?? (row.poNo ? `PO ${row.poNo}` : '—'))
      ),
    sub: (row) => [row.docNo && row.poNo ? `PO ${row.poNo}` : null, row.partyName].filter(Boolean).join(' · ') || undefined,
  },
  { key: 'createdAt', label: 'Raised', nowrap: true, render: (row) => dayTime(row.createdAt) },
]

const adjustmentColumns: Column<StockAdjustment>[] = [
  { key: 'itemCode', label: 'Item', nowrap: true },
  { key: 'qty', label: 'Quantity', num: true, render: (row) => qty(row.qty, row.uom) },
  {
    key: 'createdByName',
    label: 'Recorded by',
    render: (row) => row.createdByName ?? '—',
    sub: (row) => `via ${VIA_LABEL[row.createdVia] ?? row.createdVia}`,
  },
  { key: 'effectiveAt', label: 'When', nowrap: true, render: (row) => dayTime(row.effectiveAt ?? row.createdAt) },
  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} />, sub: (row) => (row.closedAt ? dayTime(row.closedAt) : undefined) },
  { key: 'note', label: 'Note', render: (row) => row.closedNote ?? row.note ?? row.reason ?? '—' },
  {
    key: 'id',
    label: 'Action',
    render: (row) => (row.status === 'active' ? <CancelReceiptButton id={row.id} label={`${qty(row.qty, row.uom)} ${row.itemCode}`} /> : '—'),
  },
]

function BuyingKpis({ kpis }: { kpis: ProcurementKpis }) {
  return (
    <KpiStrip label="Buying in figures">
      <Kpi chip="PO" label="Open purchase orders" value={num(kpis.openPos)} stamp="Not yet fully received" />
      <Kpi chip="₹" tone="leaf" label="Still to come" value={inrShort(kpis.openPoValue)} stamp="Value of what open orders have not delivered" />
      <Kpi chip="GRN" label="Goods receipts this month" value={num(kpis.grnsMtd)} stamp="Posted since the 1st" />
      <Kpi
        chip="FI"
        tone="amber"
        label="Free-issue receipts this month"
        value={num(kpis.freeIssueGrnsMtd)}
        stamp="Material a customer supplied at no charge"
      />
    </KpiStrip>
  )
}

/** Requests and unposted receipts are Tierra's own records; they show with or without the SAP import. */
async function TierraTab({ tab, meta }: { tab: 'requests' | 'adjustments'; meta: Meta }) {
  const apiPath = `/api/procurement?tab=${tab}`
  const query: Query = { tab }
  if (tab === 'requests') {
    const data = await api<ProcurementRequestsResponse>(apiPath)
    const open = data.rows.filter((row) => row.status === 'open').length
    return (
      <>
        <DataAsOf meta={meta} />
        {meta.dataAsOf ? <BuyingKpis kpis={data.kpis} /> : null}
        <section className="sec" aria-labelledby="buy-head">
          <SectionHead
            id="buy-head"
            title="Requests"
            sub={`What Tierra sales orders need bought, expedited or made. ${num(open)} open. Customer-supplied shortages are never bought; they become a follow-up task instead.`}
            zid="Zone 1 · Buy"
          />
          <div className="toolbar">
            <Tabs label="Buying views" param="tab" path={PATH} query={query} reset={{ q: undefined }} active={tab} options={TAB_OPTIONS} />
          </div>
          <DataTable
            caption="Procurement requests"
            columns={requestColumns}
            rows={data.rows}
            rowKey={(row) => row.id}
            empty={<p>No procurement requests yet. They are raised when a Tierra sales order is short of stock or materials.</p>}
          />
        </section>
      </>
    )
  }
  const data = await api<StockAdjustmentsResponse>(apiPath)
  return (
    <>
      <DataAsOf meta={meta} />
      {meta.dataAsOf ? <BuyingKpis kpis={data.kpis} /> : null}
      <section className="sec" aria-labelledby="buy-head">
        <SectionHead
          id="buy-head"
          title="Unposted receipts"
          sub="Stock received before it is posted in SAP. The stock check counts these until the next SAP import takes them in."
          zid="Zone 1 · Buy"
        />
        <div className="toolbar">
          <Tabs label="Buying views" param="tab" path={PATH} query={query} reset={{ q: undefined }} active={tab} options={TAB_OPTIONS} />
        </div>
        <ReceiptForm />
        <DataTable
          caption="Unposted receipts"
          columns={adjustmentColumns}
          rows={data.rows}
          rowKey={(row) => row.id}
          empty={<p>No unposted receipts. Record one above, or tell Tierra Bot “received 20 kg &lt;item code&gt;”.</p>}
        />
      </section>
    </>
  )
}

export default async function ProcurementPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const tab = oneOf(first(params.tab), PROCUREMENT_TABS, 'pos')
  const q = first(params.q)
  const page = pageOf(first(params.page))
  const query: Query = { tab: tab === 'pos' ? undefined : tab, q, page: page > 1 ? String(page) : undefined }

  const meta = await getMeta()
  if (tab === 'requests' || tab === 'adjustments') return <TierraTab tab={tab} meta={meta} />
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <div className="toolbar">
          <Tabs label="Buying views" param="tab" path={PATH} query={query} active={tab} options={TAB_OPTIONS} />
        </div>
        <NotImported what="Purchase orders and goods receipts" />
      </>
    )
  }
  const apiPath = hrefFor('/api/procurement', { tab, q, page: String(page) })
  const data = tab === 'pos' ? await api<PurchaseOrdersResponse>(apiPath) : await api<GrnsResponse>(apiPath)
  // SAP files on record: a PO's print, a GRN's supplier bill or banana slip
  const object = tab === 'pos' ? '22' : '20'
  const files = await documentFiles(data.rows.map((row) => `${object}:${row.docEntry}`))
  const withFiles = <T extends { docEntry: number }>(rows: T[]) => rows.map((row) => ({ ...row, files: files[`${object}:${row.docEntry}`] }))
  const { kpis } = data
  const empty = q ? (
    <p>
      Nothing matches “{q}”. <Link href={hrefFor(PATH, { tab: query.tab })}>Clear the search</Link>
    </p>
  ) : (
    <p>{tab === 'pos' ? 'No purchase orders in SAP yet.' : 'No goods receipts in SAP yet.'}</p>
  )

  return (
    <>
      <DataAsOf meta={meta} />
      <BuyingKpis kpis={kpis} />
      <section className="sec" aria-labelledby="buy-head">
        <SectionHead
          id="buy-head"
          title={tab === 'pos' ? 'Purchase orders' : 'Goods receipts'}
          sub={
            tab === 'pos'
              ? 'Purchase orders raised in SAP, newest first. Still to come is the value not yet received.'
              : 'Goods received into stock, newest first. Free issue marks material received at zero price, usually supplied by a customer.'
          }
          zid="Zone 1 · Buy"
        />
        <div className="toolbar">
          <Tabs
            label="Buying views"
            param="tab"
            path={PATH}
            query={query}
            active={tab}
            options={TAB_OPTIONS}
          />
          <SearchBox
            path={PATH}
            query={query}
            label={tab === 'pos' ? 'Search purchase orders' : 'Search goods receipts'}
            placeholder="Number, vendor or item"
          />
        </div>
        {tab === 'pos' ? (
          <DataTable
            caption="Purchase orders"
            columns={poColumns}
            rows={withFiles((data as PurchaseOrdersResponse).rows)}
            rowKey={(row) => row.docEntry}
            empty={empty}
          />
        ) : (
          <DataTable
            caption="Goods receipts"
            columns={grnColumns}
            rows={withFiles((data as GrnsResponse).rows)}
            rowKey={(row) => row.docEntry}
            empty={empty}
          />
        )}
        <Pager
          page={data.page}
          pageSize={data.pageSize}
          total={data.total}
          path={PATH}
          query={query}
          noun={tab === 'pos' ? 'purchase orders' : 'goods receipts'}
        />
      </section>
    </>
  )
}

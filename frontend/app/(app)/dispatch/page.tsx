import Link from 'next/link'
import { DataAsOf, NotImported } from '@/components/data-as-of'
import { DataTable, type Column } from '@/components/data-table'
import { DayPicker } from '@/components/day-picker'
import { DocList } from '@/components/doc-list'
import { Kpi, KpiStrip } from '@/components/kpi'
import { SectionHead } from '@/components/section-head'
import { EwbNumber, StatusPill, irnTone } from '@/components/status-pill'
import { api, documentFiles, getMeta } from '@/lib/api'
import { addDays, day, inr, inrShort, isIsoDay, num, time } from '@/lib/format'
import { first, hrefFor, type SearchParams } from '@/lib/query'
import type { DispatchResponse, DocFile, InvoiceRow } from '@/lib/types'

type Row = InvoiceRow & { files?: DocFile[] }

const PATH = '/dispatch'

const columns: Column<Row>[] = [
  {
    key: 'docNo',
    label: 'Invoice',
    nowrap: true,
    render: (row) =>
      row.soDocEntries.length > 0 ? (
        <Link href={`/orders/so/${row.soDocEntries[0]}`}>
          <b>{row.docNo}</b>
        </Link>
      ) : (
        <b>{row.docNo}</b>
      ),
    sub: (row) => (row.createdAt ? `Raised ${time(row.createdAt)}` : undefined),
  },
  { key: 'cardName', label: 'Customer' },
  { key: 'customerPoNo', label: 'Customer PO' },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total), tone: (row) => (row.total < 0 ? 'neg' : undefined) },
  {
    key: 'ewbNo',
    label: 'E-way bill',
    render: (row) => <EwbNumber ewbNo={row.ewbNo} cancelled={row.ewbCancelled} />,
    tone: (row) => (row.ewbNo ? 'num' : 'muted'),
  },
  {
    key: 'ewbAt',
    label: 'EWB time',
    num: true,
    render: (row) => (row.ewbAt ? time(row.ewbAt) : '—'),
    sub: (row) => (row.ewbAt && day(row.ewbAt) !== day(row.docDate) ? day(row.ewbAt) : undefined),
  },
  {
    key: 'irnStatus',
    label: 'IRN',
    render: (row) => (row.irnStatus ? <StatusPill status={row.irnStatus} tone={irnTone(row.irnStatus)} /> : 'None'),
    sub: (row) => (row.ackNo ? `Ack ${row.ackNo}` : undefined),
  },
  { key: 'files', label: 'Docs', render: (row) => <DocList files={row.files} compact /> },
]

export default async function DispatchPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const asked = first(params.date)
  const date = isIsoDay(asked) ? asked : undefined

  const meta = await getMeta()
  if (!meta.dataAsOf) {
    return (
      <>
        <DataAsOf meta={meta} />
        <NotImported what="Invoices, e-way bills and e-invoice status" />
      </>
    )
  }
  const data = await api<DispatchResponse>(hrefFor('/api/dispatch', { date }))
  const files = await documentFiles(data.rows.map((row) => `13:${row.docEntry}`))
  const rows: Row[] = data.rows.map((row) => ({ ...row, files: files[`13:${row.docEntry}`] }))
  const shown = data.date ?? date ?? meta.dataAsOf
  const { kpis } = data
  const total = data.rows.reduce((sum, row) => sum + row.total, 0)
  const before = addDays(shown, -1)
  const after = addDays(shown, 1)

  return (
    <>
      <DataAsOf meta={meta} />
      <div className="toolbar">
        <DayPicker path={PATH} query={{}} value={shown} max={meta.dataAsOf} label="Invoices dated" />
        <nav className="actions" aria-label="Nearby days">
          <Link className="btn-sec" href={hrefFor(PATH, { date: before })}>
            Previous day
          </Link>
          {after <= meta.dataAsOf ? (
            <Link className="btn-sec" href={hrefFor(PATH, { date: after })}>
              Next day
            </Link>
          ) : null}
          {shown !== meta.dataAsOf ? (
            <Link className="btn-sec" href={PATH}>
              Latest day
            </Link>
          ) : null}
        </nav>
      </div>
      <KpiStrip label={`Dispatch on ${day(shown)}`}>
        <Kpi chip="INV" label="Invoices" value={num(kpis.invoices)} stamp={`Dated ${day(shown)}`} />
        <Kpi chip="₹" tone="leaf" label="Invoiced value" value={inrShort(kpis.value)} stamp="Including tax" />
        <Kpi
          chip="EWB"
          label="E-way bills"
          value={num(kpis.ewaybills)}
          stamp={kpis.invoices > kpis.ewaybills ? `${num(kpis.invoices - kpis.ewaybills)} ${kpis.invoices - kpis.ewaybills === 1 ? 'invoice' : 'invoices'} without one` : 'Every invoice has one'}
        />
        <Kpi
          chip="IRN"
          tone={kpis.irnFailures > 0 ? 'coral' : 'ink'}
          label="IRN failures"
          value={num(kpis.irnFailures)}
          stamp="E-invoices the portal did not accept"
          attn={kpis.irnFailures > 0}
        />
      </KpiStrip>
      <section className="sec" aria-labelledby="dispatch-head">
        <SectionHead
          id="dispatch-head"
          title={`Invoices on ${day(shown)}`}
          sub="Vehicle and transporter are not recorded in SAP, so this list shows what was invoiced and its e-way bill, not the trucks."
          zid="Zone 1 · Dispatch"
        />
        <DataTable
          caption={`Invoices dated ${day(shown)}`}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.docEntry}
          empty={<p>No invoices dated {day(shown)}. Try another day.</p>}
          total={{ total: inr(total) }}
        />
      </section>
    </>
  )
}

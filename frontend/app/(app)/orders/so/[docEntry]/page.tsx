import Link from 'next/link'
import { DataTable, type Column } from '@/components/data-table'
import { DetailFrame, Facts, Milestones, type Milestone } from '@/components/detail-frame'
import { DocList } from '@/components/doc-list'
import { SectionHead } from '@/components/section-head'
import { EwbNumber, StatusPill, irnTone } from '@/components/status-pill'
import { apiOr404, documentFiles } from '@/lib/api'
import { day, dayTime, inr, num, qty, rate } from '@/lib/format'
import type { ApprovalRow, DocFile, InvoiceRow, SalesOrderLine, SalesOrderResponse } from '@/lib/types'

function taxText(line: SalesOrderLine): string | undefined {
  const pct = line.taxPct !== null ? `${num(line.taxPct, 2)}%` : null
  if (!line.taxCode && !pct) return undefined
  return [line.taxCode, pct].filter(Boolean).join(' · ')
}

const lineColumns: Column<SalesOrderLine>[] = [
  {
    key: 'itemCode',
    label: 'Item',
    sub: (line) => (line.whsCode ? `${line.itemName} · ${line.whsCode}` : line.itemName),
  },
  { key: 'qty', label: 'Ordered', num: true, render: (line) => qty(line.qty) },
  {
    key: 'openQty',
    label: 'Still open',
    num: true,
    render: (line) => qty(line.openQty),
    tone: (line) => (line.openQty > 0 ? 'warn' : undefined),
  },
  { key: 'price', label: 'Rate', num: true, render: (line) => rate(line.price), sub: taxText },
  {
    key: 'lineTotal',
    label: 'Line total',
    num: true,
    render: (line) => inr(line.lineTotal, 2),
    tone: (line) => (line.lineTotal < 0 ? 'neg' : undefined),
  },
  { key: 'lineStatus', label: 'Status', render: (line) => <StatusPill status={line.lineStatus} /> },
]

const invoiceColumns: Column<InvoiceRow & { files?: DocFile[] }>[] = [
  { key: 'docNo', label: 'Invoice', nowrap: true, sub: (invoice) => day(invoice.docDate) },
  { key: 'total', label: 'Value', num: true, render: (invoice) => inr(invoice.total) },
  {
    key: 'ewbNo',
    label: 'E-way bill',
    render: (invoice) => <EwbNumber ewbNo={invoice.ewbNo} cancelled={invoice.ewbCancelled} />,
    sub: (invoice) => (invoice.ewbAt ? dayTime(invoice.ewbAt) : undefined),
  },
  {
    key: 'irnStatus',
    label: 'IRN',
    render: (invoice) =>
      invoice.irnStatus ? <StatusPill status={invoice.irnStatus} tone={irnTone(invoice.irnStatus)} /> : 'None',
    sub: (invoice) => (invoice.ackNo ? `Ack ${invoice.ackNo}` : undefined),
  },
  { key: 'files', label: 'Docs', render: (invoice) => <DocList files={invoice.files} compact /> },
]

function approvalStep(approval: ApprovalRow, index: number): Milestone {
  const verb = approval.status === 'approved' ? 'Approved' : approval.status === 'rejected' ? 'Rejected' : 'Waiting'
  return {
    key: `${approval.draftEntry ?? approval.docEntry ?? 'a'}-${index}`,
    title: `${verb}${approval.approver ? ` · ${approval.approver}` : ''}`,
    note: approval.originator ? `Asked by ${approval.originator}` : undefined,
    when: approval.decidedAt ? dayTime(approval.decidedAt) : approval.requestedAt ? `Asked ${dayTime(approval.requestedAt)}` : undefined,
    waiting: approval.status === 'waiting',
  }
}

function historySteps({ order, invoices }: SalesOrderResponse): Milestone[] {
  const steps: Milestone[] = [
    {
      key: 'raised',
      title: 'Sales order raised',
      note: order.createdBy ? `By ${order.createdBy}` : undefined,
      when: day(order.docDate),
    },
    ...[...invoices]
      .sort((a, b) => a.docDate.localeCompare(b.docDate))
      .map((invoice) => ({
        key: `inv-${invoice.docEntry}`,
        title: `Invoiced ${invoice.docNo}`,
        note: invoice.ewbNo
          ? `E-way bill ${invoice.ewbNo}${invoice.ewbCancelled ? ' (cancelled)' : ''}`
          : 'No e-way bill',
        when: day(invoice.docDate),
      })),
  ]
  if (order.status === 'open') steps.push({ key: 'end', title: 'Open', note: order.stale ? 'Over 90 days old' : undefined, waiting: true })
  else steps.push({ key: 'end', title: order.status === 'cancelled' ? 'Cancelled' : 'Closed' })
  return steps
}

export default async function SalesOrderPage({ params }: { params: Promise<{ docEntry: string }> }) {
  const { docEntry } = await params
  // The API answers 404 for an unknown or malformed number, which apiOr404 turns into the 404 page.
  const data = await apiOr404<SalesOrderResponse>(`/api/orders/so/${encodeURIComponent(docEntry)}`)
  const { order, lines, invoices, approvals } = data
  const files = await documentFiles([`17:${order.docEntry}`, ...invoices.map((invoice) => `13:${invoice.docEntry}`)])
  const soFiles = files[`17:${order.docEntry}`]
  const lineTotal = lines.reduce((sum, line) => sum + line.lineTotal, 0)

  return (
    <DetailFrame
      rail={
        <>
          <Milestones title="Approvals" items={approvals.map(approvalStep)} empty="No approval was needed in SAP." />
          <Milestones title="History" items={historySteps(data)} empty="" />
        </>
      }
    >
      <section className="sec" aria-labelledby="so-head">
        <SectionHead
          id="so-head"
          title={order.docNo}
          sub={`${order.cardName}${order.customerPoNo ? ` · PO ${order.customerPoNo}` : ''}`}
          actions={
            <span className="pills">
              <StatusPill status={order.status} />
              {order.stale && order.status === 'open' ? <StatusPill status="stale" label="Over 90 days" /> : null}
            </span>
          }
        />
        <Facts
          label="Order details"
          items={[
            { label: 'Customer', value: `${order.cardName} (${order.cardCode})` },
            { label: 'Customer PO', value: order.customerPoNo ? `${order.customerPoNo}${order.poDate ? `, ${day(order.poDate)}` : ''}` : 'None' },
            { label: 'Order date', value: day(order.docDate) },
            { label: 'Due', value: day(order.dueDate) },
            { label: 'Ship to', value: order.shipToCode ?? '—' },
            { label: 'Approval', value: order.approvalStatus ? <StatusPill status={order.approvalStatus} /> : 'Not needed' },
            { label: 'Value', value: <span className="num">{inr(order.total)}</span> },
            { label: 'Of which tax', value: <span className="num">{inr(order.taxTotal)}</span> },
            { label: 'Raised by', value: order.createdBy ?? '—' },
            { label: 'Files in SAP', value: <DocList files={soFiles} empty="None" /> },
          ]}
        />
      </section>
      <section className="sec" aria-labelledby="lines-head">
        <SectionHead
          id="lines-head"
          title="What was ordered"
          sub={`${num(lines.length)} ${lines.length === 1 ? 'line' : 'lines'} · ${qty(order.totalQty)} ordered`}
        />
        <DataTable
          caption={`Lines on ${order.docNo}`}
          columns={lineColumns}
          rows={lines}
          rowKey={(line) => line.lineNum}
          empty={<p>This order has no lines in SAP.</p>}
          total={{
            qty: qty(lines.reduce((sum, line) => sum + line.qty, 0)),
            openQty: qty(lines.reduce((sum, line) => sum + line.openQty, 0)),
            lineTotal: inr(lineTotal, 2),
          }}
          totalLabel="Before tax"
        />
      </section>
      <section className="sec" aria-labelledby="inv-head">
        <SectionHead id="inv-head" title="Invoices" sub="Invoices raised against this order, with their e-way bill and e-invoice (IRN) status, and the files SAP has for each." />
        <DataTable
          caption={`Invoices against ${order.docNo}`}
          columns={invoiceColumns}
          rows={invoices.map((invoice) => ({ ...invoice, files: files[`13:${invoice.docEntry}`] }))}
          rowKey={(invoice) => invoice.docEntry}
          empty={<p>Not invoiced yet.</p>}
        />
      </section>
      <p>
        <Link className="backlink" href="/orders">
          All sales orders
        </Link>
      </p>
    </DetailFrame>
  )
}

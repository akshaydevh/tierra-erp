import Link from 'next/link'
import { DataTable, type Column } from '@/components/data-table'
import { DetailFrame, Facts, Milestones, type Milestone } from '@/components/detail-frame'
import { DocList } from '@/components/doc-list'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { decisionText } from '@/components/task-bits'
import { CancelTsoButton } from '@/components/record-actions'
import { ApiError, api, apiOr404, documentFiles } from '@/lib/api'
import { day, dayTime, inr, num, qty } from '@/lib/format'
import {
  CANCELLABLE_TSO,
  TASK_STATUS_LABELS,
  roleLabel,
  type Approval,
  type DocFile,
  type DocumentInfo,
  type Me,
  type ProcurementRequest,
  type SalesOrderResponse,
  type TsoLine,
  type TsoResponse,
} from '@/lib/types'

const lineColumns: Column<TsoLine>[] = [
  { key: 'lineNo', label: '#', num: true },
  {
    key: 'itemCode',
    label: 'Item',
    nowrap: true,
    sub: (line) => [line.itemName, line.description && line.description !== line.itemName ? `PO: ${line.description}` : null].filter(Boolean).join(' · ') || undefined,
  },
  {
    key: 'articleNo',
    label: 'Article / EAN',
    render: (line) => line.articleNo ?? '—',
    sub: (line) => (line.ean ? `EAN ${line.ean}` : undefined),
  },
  {
    key: 'hsn',
    label: 'HSN',
    nowrap: true,
    render: (line) => line.hsn ?? '—',
    sub: (line) => (line.poHsn && line.poHsn !== line.hsn ? `PO says ${line.poHsn}` : undefined),
    tone: (line) => (line.poHsn && line.poHsn !== line.hsn ? 'warn' : undefined),
  },
  {
    key: 'pcs',
    label: 'Pieces',
    num: true,
    render: (line) => qty(line.pcs),
    sub: (line) => (line.uom ? `${qty(line.qty)} ${line.uom}${line.pcsPerUom ? ` × ${num(line.pcsPerUom)}` : ''}` : undefined),
  },
  { key: 'cartons', label: 'Boxes', num: true, render: (line) => qty(line.cartons) },
  {
    key: 'unitPrice',
    label: 'Per piece',
    num: true,
    render: (line) => `₹${line.unitPrice.toFixed(4)}`,
    sub: (line) => (line.mrp !== null ? `MRP ${inr(line.mrp, 2)}` : undefined),
  },
  {
    key: 'amount',
    label: 'Amount',
    num: true,
    render: (line) => inr(line.amount, 2),
    sub: (line) => `GST ${num(line.gstPct, 2)}% · ${inr(line.taxAmount, 2)}`,
  },
  { key: 'reservedPcs', label: 'From stock', num: true, render: (line) => qty(line.reservedPcs) },
  {
    key: 'toMake',
    label: 'To make',
    num: true,
    render: (line) => (line.toMake > 0 ? qty(line.toMake) : '—'),
    tone: (line) => (line.toMake > 0 ? 'warn' : undefined),
  },
]

type SapDocFiles = { docNo: string; href: string | null; files: DocFile[] | undefined }

/** The SAP sales order keyed for this TSO and its invoices, with the files SAP has for each (null before SAP). */
async function sapFiles(sapDocEntry: number | null): Promise<SapDocFiles[] | null> {
  if (!sapDocEntry) return null
  let so: SalesOrderResponse
  try {
    so = await api<SalesOrderResponse>(`/api/orders/so/${sapDocEntry}`)
  } catch (error) {
    if (error instanceof ApiError) return null
    throw error
  }
  const files = await documentFiles([`17:${so.order.docEntry}`, ...so.invoices.map((invoice) => `13:${invoice.docEntry}`)])
  return [
    { docNo: so.order.docNo, href: `/orders/so/${so.order.docEntry}`, files: files[`17:${so.order.docEntry}`] },
    ...so.invoices.map((invoice) => ({ docNo: invoice.docNo, href: null, files: files[`13:${invoice.docEntry}`] })),
  ]
}

const DOC_LABEL: Record<string, string> = {
  so_pdf: 'Customer copy',
  so_annex: 'Annex (internal)',
  customer_po: 'Customer PO',
  report: 'Report',
  other: 'Document',
}

/** Newest version first; within a version the customer copy before the internal annex. */
function docRank(doc: DocumentInfo): number {
  return doc.kind === 'so_pdf' ? 0 : doc.kind === 'so_annex' ? 1 : 2
}

function documentStep(doc: DocumentInfo): Milestone {
  return {
    key: doc.id,
    title: (
      <a className="tasklink" href={`/api/documents/${encodeURIComponent(doc.id)}`} target="_blank" rel="noreferrer">
        {DOC_LABEL[doc.kind] ?? doc.kind} · v{doc.version}
      </a>
    ),
    note: doc.filename,
    when: dayTime(doc.createdAt),
  }
}

function approvalStep(approval: Approval): Milestone {
  const pending = approval.status === 'pending'
  return {
    key: approval.id,
    title: (
      <>
        Version {approval.version}: <StatusPill status={approval.status} />
      </>
    ),
    note: [
      pending ? `Waiting for the ${roleLabel(approval.approverRole).toLowerCase()}` : decisionText(approval),
      approval.decidedByName ? `by ${approval.decidedByName}` : null,
      approval.note ? `“${approval.note}”` : null,
      approval.selfRaised ? 'self-raised' : null,
    ]
      .filter(Boolean)
      .join(' · '),
    when: approval.decidedAt ? dayTime(approval.decidedAt) : `Asked ${dayTime(approval.createdAt)}`,
    waiting: pending,
  }
}

function requestStep(request: ProcurementRequest): Milestone {
  return {
    key: request.id,
    title: (
      <>
        {request.itemCode} · {qty(request.qty, request.uom)} <StatusPill status={request.reason} />
      </>
    ),
    note: [request.itemName, request.note, request.status === 'open' ? null : request.status].filter(Boolean).join(' · ') || undefined,
    when: dayTime(request.createdAt),
    waiting: request.status === 'open',
  }
}

export default async function TierraSalesOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [data, { user }] = await Promise.all([
    apiOr404<TsoResponse>(`/api/sales-orders/${encodeURIComponent(id)}`),
    api<{ user: Me }>('/api/auth/me'),
  ])
  const { order, po, check, approvals, requests, documents, warnings, tasks, make, cardName, group } = data
  const inSap = await sapFiles(order.sapDocEntry)
  const igst = order.taxKind === 'igst'
  const docs = [...documents].sort((a, b) => b.version - a.version || docRank(a) - docRank(b))
  const trail = [...approvals].sort((a, b) => a.version - b.version || a.createdAt.localeCompare(b.createdAt))
  const reserved = order.lines.reduce((sum, line) => sum + line.reservedPcs, 0)
  const toMake = order.lines.reduce((sum, line) => sum + line.toMake, 0)

  const taskSteps: Milestone[] = tasks.map((task) => ({
    key: task.id,
    title: task.title,
    note: `${task.assigneeName ?? (task.assigneeRole ? roleLabel(task.assigneeRole) : 'Unassigned')} · ${TASK_STATUS_LABELS[task.status]}`,
    when: dayTime(task.createdAt),
    waiting: task.status === 'todo' || task.status === 'doing',
  }))

  return (
    <DetailFrame
      rail={
        <>
          <article className="card p6">
            <div className="zid">Stock check</div>
            {check ? (
              <div className="railcheck">
                <StatusPill status={check.verdict} />
                <span className="stamp">
                  {check.dataAsOf ? `SAP data as of ${day(check.dataAsOf)}` : 'Checked'} · {dayTime(check.createdAt)}
                </span>
                {order.customerPoId ? (
                  <Link className="tasklink" href={`/orders/po/${encodeURIComponent(order.customerPoId)}#po-check-head`}>
                    See the check
                  </Link>
                ) : null}
              </div>
            ) : (
              <p className="stamp railempty">No stock check is linked to this order.</p>
            )}
          </article>
          <Milestones title="PDF versions" items={docs.map(documentStep)} empty="No PDF generated yet." />
          {inSap ? (
            <article className="card p6">
              <div className="zid">Files in SAP</div>
              <ul className="sapfiles">
                {inSap.map((doc) => (
                  <li key={doc.docNo}>
                    {doc.href ? (
                      <Link className="tasklink" href={doc.href}>
                        {doc.docNo}
                      </Link>
                    ) : (
                      <b>{doc.docNo}</b>
                    )}
                    <DocList files={doc.files} compact empty="No file on record" />
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
          <Milestones title="Approval trail" items={trail.map(approvalStep)} empty="Not sent for approval yet." />
          <Milestones title="Procurement requests" items={requests.map(requestStep)} empty="Nothing to buy or make for this order." />
          <Milestones title="Tasks" items={taskSteps} empty="No tasks about this order." />
        </>
      }
    >
      <section className="sec" aria-labelledby="tso-head">
        <SectionHead
          id="tso-head"
          title={`${order.docNo}${order.version > 1 ? ` · version ${order.version}` : ''}`}
          sub={[order.partyName, cardName ? `${order.cardCode} ${cardName}` : order.cardCode].filter(Boolean).join(' · ')}
          actions={
            <span className="pills">
              <StatusPill status={order.status} />
              {check ? <StatusPill status={check.verdict} /> : null}
              {user.role === 'admin' && CANCELLABLE_TSO.includes(order.status) ? <CancelTsoButton orderId={order.id} docNo={order.docNo} /> : null}
            </span>
          }
        />
        <Facts
          label="Order details"
          items={[
            { label: 'Customer', value: order.partyName ?? '—' },
            { label: 'Bill-to card', value: cardName ? `${order.cardCode} ${cardName}` : order.cardCode },
            {
              label: 'Customer PO',
              value: order.customerPoNo ? (
                order.customerPoId ? (
                  <Link className="tasklink" href={`/orders/po/${encodeURIComponent(order.customerPoId)}`}>
                    {order.customerPoNo}
                  </Link>
                ) : (
                  order.customerPoNo
                )
              ) : (
                'None'
              ),
            },
            { label: 'PO date', value: day(order.poDate) },
            { label: 'Order date', value: day(order.docDate) },
            { label: 'Delivery', value: day(order.deliveryDate) },
            { label: 'Delivery term', value: order.deliveryTerm ?? '—' },
            { label: 'Payment terms', value: order.paymentTerms ?? '—' },
            { label: 'Site', value: order.siteCode ?? '—' },
            { label: 'Vendor code', value: order.vendorCode ?? '—' },
            {
              label: 'Place of supply',
              value: [order.placeOfSupply, order.stateCode ? `state ${order.stateCode}` : null].filter(Boolean).join(', ') || '—',
            },
            { label: 'Ship-to GSTIN', value: order.shipToGstin ?? '—' },
            { label: 'Customer group', value: group ? group.subject : 'None mapped: the copy is not sent anywhere' },
            { label: 'Approved', value: order.approvedAt ? dayTime(order.approvedAt) : '—' },
            {
              label: 'Sent to customer',
              value: order.sentAt ? dayTime(order.sentAt) : order.status === 'approved_unsent' ? 'Not sent: the office sends it by hand' : '—',
            },
            { label: 'In SAP', value: order.sapDocNo ?? (order.status === 'cancelled' ? '—' : 'Not keyed yet') },
            ...(order.cancelledAt ? [{ label: 'Cancelled', value: dayTime(order.cancelledAt) }] : []),
          ]}
        />
        {po?.shipToAddress ? <p className="note">Deliver to: {po.shipToAddress}</p> : null}
      </section>

      <section className="sec" aria-labelledby="tso-lines-head">
        <SectionHead
          id="tso-lines-head"
          title="Lines"
          sub={`${num(order.lines.length)} ${order.lines.length === 1 ? 'line' : 'lines'} · ${qty(reserved)} pieces from stock · ${qty(toMake)} to make`}
        />
        <DataTable
          caption={`Lines of ${order.docNo}`}
          columns={lineColumns}
          rows={order.lines}
          rowKey={(line) => line.lineNo}
          empty={<p>This sales order has no lines.</p>}
          total={{
            pcs: qty(order.lines.reduce((sum, line) => sum + line.pcs, 0)),
            cartons: qty(order.lines.reduce((sum, line) => sum + (line.cartons ?? 0), 0)),
            amount: inr(order.basicTotal, 2),
            reservedPcs: qty(reserved),
            toMake: qty(toMake),
          }}
          totalLabel="Taxable"
        />
        <dl className="card p6 totals" aria-label="Totals">
          <div>
            <dt>Taxable value</dt>
            <dd className="num">{inr(order.basicTotal, 2)}</dd>
          </div>
          {igst ? (
            <div>
              <dt>IGST</dt>
              <dd className="num">{inr(order.igst, 2)}</dd>
            </div>
          ) : (
            <>
              <div>
                <dt>CGST</dt>
                <dd className="num">{inr(order.cgst, 2)}</dd>
              </div>
              <div>
                <dt>SGST</dt>
                <dd className="num">{inr(order.sgst, 2)}</dd>
              </div>
            </>
          )}
          {order.cess > 0 ? (
            <div>
              <dt>Cess</dt>
              <dd className="num">{inr(order.cess, 2)}</dd>
            </div>
          ) : null}
          <div className="grand">
            <dt>Total</dt>
            <dd className="num">{inr(order.total, 2)}</dd>
          </div>
        </dl>
      </section>

      {warnings.length || make.length ? (
        <section className="sec" aria-labelledby="tso-warn-head">
          <SectionHead id="tso-warn-head" title="Internal notes" sub="For Tierra only; none of this is printed on the customer copy." />
          <article className="card p6">
            {warnings.length ? (
              <>
                <b>Warnings</b>
                <ul className="note">
                  {warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </>
            ) : null}
            {make.length ? (
              <>
                <b>To make</b>
                <ul className="note">
                  {make.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </article>
        </section>
      ) : null}

      {order.notes.length ? (
        <section className="sec" aria-labelledby="tso-notes-head">
          <SectionHead id="tso-notes-head" title="Notes on the order" />
          <article className="card p6">
            <ul className="note">
              {order.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          </article>
        </section>
      ) : null}

      <p>
        <Link className="backlink" href="/orders?tab=tso">
          All Tierra sales orders
        </Link>
      </p>
    </DetailFrame>
  )
}

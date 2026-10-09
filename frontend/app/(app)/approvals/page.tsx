import Link from 'next/link'
import { ApprovalActions, DecisionNotices } from '@/components/approval-actions'
import { DataTable, type Column } from '@/components/data-table'
import { Kpi, KpiStrip } from '@/components/kpi'
import { Pager } from '@/components/pager'
import { SectionHead } from '@/components/section-head'
import { StatusPill } from '@/components/status-pill'
import { ApprovalPdfs, ApprovalSummary, decisionText } from '@/components/task-bits'
import { api } from '@/lib/api'
import { day, dayTime, inr, num } from '@/lib/format'
import { first, pageOf, type Query, type SearchParams } from '@/lib/query'
import { roleLabel, type ApprovalHistoryRow, type ApprovalView, type ApprovalsResponse } from '@/lib/types'

const PATH = '/approvals'

function WaitingCard({ approval, canDecide }: { approval: ApprovalView; canDecide: boolean }) {
  const order = approval.order
  return (
    <article className="card daycard" aria-label={order?.docNo ?? 'Sales order approval'}>
      <div className="daytop">
        <div>
          {order ? (
            <Link className="aplink" href={`/orders/tso/${encodeURIComponent(order.id)}`}>
              {order.docNo}
            </Link>
          ) : (
            <b>Sales order not found</b>
          )}
          <div className="stamp">
            {[order?.partyName ?? order?.cardCode, order?.customerPoNo ? `PO ${order.customerPoNo}` : null].filter(Boolean).join(' · ')}
          </div>
        </div>
        <span className="pills">
          <StatusPill status="pending" label={`Waiting since ${dayTime(approval.createdAt)}`} />
          {approval.selfRaised ? (
            <span className="pill amber" title="The approver also forwarded the PO">
              Self-raised
            </span>
          ) : null}
        </span>
      </div>
      <ApprovalSummary approval={approval} />
      <div className="daymeta">
        <ApprovalPdfs approval={approval} />
        <span className="stamp">
          For the {roleLabel(approval.approverRole).toLowerCase()}
          {approval.waMessages ? ' · also on WhatsApp (reply or 👍 there)' : ''}
        </span>
      </div>
      {canDecide && approval.taskId ? (
        <ApprovalActions taskId={approval.taskId} docNo={order?.docNo ?? 'this sales order'} allowReject />
      ) : canDecide ? (
        <p className="note">This approval has no task, so it can only be decided on WhatsApp.</p>
      ) : null}
    </article>
  )
}

const decidedColumns: Column<ApprovalView>[] = [
  {
    key: 'docNo',
    label: 'Sales order',
    nowrap: true,
    render: (row) =>
      row.order ? (
        <Link href={`/orders/tso/${encodeURIComponent(row.order.id)}`}>
          <b>{row.order.docNo}</b>
        </Link>
      ) : (
        '—'
      ),
    sub: (row) => `v${row.version}`,
  },
  {
    key: 'party',
    label: 'Customer',
    render: (row) => row.order?.partyName ?? row.order?.cardCode ?? '—',
    sub: (row) => (row.order?.customerPoNo ? `PO ${row.order.customerPoNo}` : undefined),
  },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.order?.total, 2) },
  { key: 'status', label: 'Decision', render: (row) => <StatusPill status={row.status} /> },
  {
    key: 'how',
    label: 'How',
    render: (row) => decisionText(row),
    sub: (row) => (row.decidedAt ? day(row.decidedAt) : undefined),
  },
  {
    key: 'by',
    label: 'By',
    render: (row) => row.decidedByName ?? '—',
    sub: (row) => (row.selfRaised ? <span className="pill amber">Self-raised</span> : undefined),
  },
  { key: 'note', label: 'Note', render: (row) => row.note ?? '—' },
]

type SapRow = ApprovalHistoryRow & { at: number }

const sapColumns: Column<SapRow>[] = [
  { key: 'docNo', label: 'Document', nowrap: true, sub: (row) => row.docType ?? undefined },
  { key: 'cardName', label: 'Customer' },
  { key: 'status', label: 'Status', render: (row) => <StatusPill status={row.status} /> },
  { key: 'originator', label: 'Asked by' },
  { key: 'approver', label: 'Approver', sub: (row) => row.remarks ?? undefined },
  { key: 'requestedAt', label: 'Requested', nowrap: true, render: (row) => dayTime(row.requestedAt) },
  { key: 'decidedAt', label: 'Decided', nowrap: true, render: (row) => dayTime(row.decidedAt) },
  { key: 'total', label: 'Value', num: true, render: (row) => inr(row.total) },
]

export default async function ApprovalsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const page = pageOf(first(params.page))
  const query: Query = { page: page > 1 ? String(page) : undefined }
  const data = await api<ApprovalsResponse>(`/api/approvals?page=${page}`)
  const { pending, decided, sap, canDecide } = data
  const approved = decided.filter((row) => row.status === 'approved').length
  const sentBack = decided.filter((row) => row.status === 'sent_back').length

  return (
    <DecisionNotices>
      <KpiStrip label="Approvals in figures">
        <Kpi chip="W" tone="amber" label="Waiting" value={num(pending.length)} stamp="Tierra sales orders for a decision" attn={pending.length > 0} />
        <Kpi chip="OK" tone="leaf" label="Approved in Tierra" value={num(approved)} stamp="Most recent 100 decisions" />
        <Kpi chip="SB" label="Sent back" value={num(sentBack)} stamp="Revised and sent again as a new version" />
        <Kpi chip="SAP" label="Decided in SAP" value={num(sap.total)} stamp="Sales-order approvals before Tierra" />
      </KpiStrip>

      <section className="sec" aria-labelledby="waiting-head">
        <SectionHead
          id="waiting-head"
          title="Waiting"
          sub={
            canDecide
              ? 'Tierra sales orders waiting for your yes. Approve sends the customer copy to the customer’s group 60 seconds later; you can stop it in that time.'
              : 'Tierra sales orders waiting for the admin. Only the admin can decide them.'
          }
          zid="Zone 1 · Waiting"
        />
        {pending.length ? (
          <div className="daylist">
            {pending.map((approval) => (
              <WaitingCard key={approval.id} approval={approval} canDecide={canDecide} />
            ))}
          </div>
        ) : (
          <div className="card empty">
            <p>Nothing is waiting for approval.</p>
          </div>
        )}
      </section>

      <section className="sec" aria-labelledby="decided-head">
        <SectionHead id="decided-head" title="Decided" sub="Tierra’s decisions, newest first: how each was decided, by whom and the note." zid="Zone 2 · Decided" />
        <DataTable
          caption="Decided Tierra approvals"
          columns={decidedColumns}
          rows={decided}
          rowKey={(row) => row.id}
          empty={<p>No Tierra sales order has been decided yet.</p>}
        />
      </section>

      <section className="sec" aria-labelledby="sap-head">
        <SectionHead
          id="sap-head"
          title="SAP history"
          sub="Sales-order approvals from SAP, before Tierra took them over. Newest request first."
          zid="Zone 2 · SAP"
        />
        <DataTable
          caption="Sales-order approvals decided in SAP"
          columns={sapColumns}
          rows={sap.rows.map((row, at): SapRow => ({ ...row, at }))}
          rowKey={(row) => row.at}
          empty={<p>No SAP approval history yet. It appears after the SAP import.</p>}
        />
        <Pager page={sap.page} pageSize={sap.pageSize} total={sap.total} path={PATH} query={query} noun="SAP decisions" />
      </section>
    </DecisionNotices>
  )
}

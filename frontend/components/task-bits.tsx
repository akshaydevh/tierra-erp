import Link from 'next/link'
import { StatusPill } from './status-pill'
import { day, dayShort, inr, time } from '@/lib/format'
import { TASK_KIND_LABELS, roleLabel, type ApprovalView, type ApprovalVia, type Task } from '@/lib/types'

// Small pieces shared by My Day, Approvals and the TSO page. Server-safe (no hooks).

const IST = 'Asia/Kolkata'

function istDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(at)
}

/** Due chip: coral when overdue, amber when due today, grey otherwise; times in India time. */
export function DueChip({ dueAt, now, done = false }: { dueAt: string | null; now: Date; done?: boolean }) {
  if (!dueAt) return null
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) return null
  const today = istDay(due) === istDay(now)
  const when = today ? `today ${time(dueAt)}` : `${dayShort(dueAt)}, ${time(dueAt)}`
  if (!done && due < now) return <span className="pill coral">Overdue · {when}</span>
  return <span className={!done && today ? 'pill amber' : 'pill grey'}>Due {when}</span>
}

export function KindChip({ task }: { task: Task }) {
  return <span className="pill ink">{TASK_KIND_LABELS[task.kind] ?? task.kind}</span>
}

/** Who holds a task: the person, else the role it is addressed to. */
export function holderName(task: Task, meId?: string): string {
  if (meId && task.assigneeId === meId) return 'you'
  if (task.assigneeName) return task.assigneeName
  if (task.assigneeRole) return roleLabel(task.assigneeRole)
  return 'unassigned'
}

/** "Raiser → holder". System-raised tasks name Tierra as the raiser. */
export function chainText(task: Task, meId?: string): string {
  const raiser = task.createdVia === 'system' ? 'Tierra' : task.createdBy === meId ? 'You' : (task.createdByName ?? 'Someone')
  return `${raiser} → ${holderName(task, meId)}`
}

/** The record a task is about, as a link; null when there is nothing to open. */
export function RecordRef({ task, approval }: { task: Task; approval?: ApprovalView }) {
  if (!task.subjectId) return null
  if (task.subjectType === 'sales_order') {
    return (
      <Link className="tasklink" href={`/orders/tso/${encodeURIComponent(task.subjectId)}`}>
        Open the sales order
      </Link>
    )
  }
  if (task.subjectType === 'customer_po') {
    return (
      <Link className="tasklink" href={`/orders/po/${encodeURIComponent(task.subjectId)}`}>
        Open the customer PO
      </Link>
    )
  }
  if (task.subjectType === 'approval' && approval?.order) {
    return (
      <Link className="tasklink" href={`/orders/tso/${encodeURIComponent(approval.order.id)}`}>
        {approval.order.docNo}
      </Link>
    )
  }
  if (task.subjectType === 'document') {
    return (
      <a className="tasklink" href={`/api/documents/${encodeURIComponent(task.subjectId)}`} target="_blank" rel="noreferrer">
        Open PDF
      </a>
    )
  }
  return null
}

/** The customer copy and the internal annex of the version being approved. */
export function ApprovalPdfs({ approval }: { approval: Pick<ApprovalView, 'soPdfId' | 'annexId' | 'version'> }) {
  if (!approval.soPdfId && !approval.annexId) return <span className="stamp">No PDF yet</span>
  return (
    <span className="pdflinks">
      {approval.soPdfId ? (
        <a className="tasklink" href={`/api/documents/${encodeURIComponent(approval.soPdfId)}`} target="_blank" rel="noreferrer">
          SO PDF{approval.version > 1 ? ` v${approval.version}` : ''}
        </a>
      ) : null}
      {approval.annexId ? (
        <a className="tasklink" href={`/api/documents/${encodeURIComponent(approval.annexId)}`} target="_blank" rel="noreferrer">
          Annex (internal)
        </a>
      ) : null}
    </span>
  )
}

/** Verdict, total, delivery and flags of an approval, as a fact strip. */
export function ApprovalSummary({ approval }: { approval: ApprovalView }) {
  const order = approval.order
  return (
    <dl className="apfacts">
      <div>
        <dt>Value</dt>
        <dd className="num">{inr(order?.total, 2)}</dd>
      </div>
      <div>
        <dt>Delivery</dt>
        <dd>{day(order?.deliveryDate)}</dd>
      </div>
      <div>
        <dt>Stock check</dt>
        <dd>{approval.verdict ? <StatusPill status={approval.verdict} /> : 'Not checked'}</dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd className="num">v{approval.version}</dd>
      </div>
    </dl>
  )
}

const VIA_TEXT: Record<ApprovalVia, string> = {
  reaction: 'WhatsApp reaction',
  reply: 'WhatsApp reply',
  text: 'WhatsApp message',
  llm: 'WhatsApp (read by the agent)',
  desk: 'the dashboard',
}

const VERB: Record<string, string> = {
  approved: 'Approved',
  sent_back: 'Sent back',
  rejected: 'Rejected',
  superseded: 'Superseded',
  pending: 'Waiting',
}

/** "Approved via WhatsApp reaction 14:02" (India time). */
export function decisionText(approval: Pick<ApprovalView, 'status' | 'via' | 'decidedAt'>): string {
  const verb = VERB[approval.status] ?? approval.status
  const via = approval.via ? ` via ${VIA_TEXT[approval.via] ?? approval.via}` : ''
  const at = approval.decidedAt ? ` ${time(approval.decidedAt)}` : ''
  return `${verb}${via}${at}`
}

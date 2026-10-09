import type { AgentDeps } from '../agent/deps'
import type { Approval, ProcurementRequest, PublicUser, SalesOrder, TaskRecord } from '../db/types'
import { approveSalesOrder, rejectSalesOrder, sendBackSalesOrder, stopGroupSend, type Decision } from './so-approval'

/** What the dashboard shows of sales orders, approvals and procurement requests (My Day, Approvals, Procurement). */

export function salesOrderSummary(order: SalesOrder) {
  return {
    id: order.id,
    docNo: order.docNo,
    status: order.status,
    version: order.version,
    partyName: order.partyName,
    cardCode: order.cardCode,
    customerPoNo: order.customerPoNo,
    customerPoId: order.customerPoId,
    docDate: order.docDate,
    deliveryDate: order.deliveryDate,
    total: order.total,
    lineCount: order.lines.length,
    pcs: order.lines.reduce((sum, line) => sum + line.pcs, 0),
    approvedAt: order.approvedAt,
    sentAt: order.sentAt,
    createdAt: order.createdAt,
  }
}

export type ApprovalView = Omit<Approval, 'waMessageIds'> & {
  waMessages: number
  order: ReturnType<typeof salesOrderSummary> | null
  verdict: string | null
}

export async function approvalViews(deps: AgentDeps, approvals: Approval[]): Promise<ApprovalView[]> {
  const out: ApprovalView[] = []
  for (const approval of approvals) {
    const order = approval.subjectType === 'sales_order' ? await deps.store.getSalesOrder(approval.subjectId) : null
    const check = order?.checkId ? await deps.store.getInventoryCheck(order.checkId) : null
    const { waMessageIds, ...rest } = approval
    out.push({ ...rest, waMessages: waMessageIds.length, order: order ? salesOrderSummary(order) : null, verdict: check?.verdict ?? null })
  }
  return out
}

/** The approval behind each approval task in the list, by task id. */
export async function approvalCards(deps: AgentDeps, tasks: TaskRecord[]): Promise<Record<string, ApprovalView>> {
  const out: Record<string, ApprovalView> = {}
  for (const task of tasks) {
    if (task.kind !== 'approval' || task.subjectType !== 'approval' || !task.subjectId) continue
    const approval = await deps.store.getApproval(task.subjectId)
    if (!approval) continue
    const [view] = await approvalViews(deps, [approval])
    if (view) out[task.id] = view
  }
  return out
}

export async function requestLabels(deps: AgentDeps, requests: ProcurementRequest[]) {
  const orders = new Map<string, SalesOrder | null>()
  const pos = new Map<string, { poNo: string | null; partyName: string | null } | null>()
  for (const row of requests) {
    if (row.salesOrderId && !orders.has(row.salesOrderId)) orders.set(row.salesOrderId, await deps.store.getSalesOrder(row.salesOrderId))
    if (row.customerPoId && !pos.has(row.customerPoId)) {
      const po = await deps.store.getCustomerPo(row.customerPoId)
      pos.set(row.customerPoId, po ? { poNo: po.poNo, partyName: po.partyName } : null)
    }
  }
  return (row: ProcurementRequest) => {
    const order = row.salesOrderId ? orders.get(row.salesOrderId) : null
    const po = row.customerPoId ? pos.get(row.customerPoId) : null
    return { docNo: order?.docNo ?? null, poNo: po?.poNo ?? order?.customerPoNo ?? null, partyName: order?.partyName ?? po?.partyName ?? null }
  }
}

export type DeskDecision = { ok: true; message: string } | { ok: false; error: string; status: 400 | 403 | 409 }

/** Approve / send back / reject / stop from the dashboard, on the admin's approval task. */
export async function decideFromDesk(
  deps: AgentDeps,
  task: TaskRecord,
  user: PublicUser,
  action: 'approve' | 'send_back' | 'reject' | 'stop',
  note: string,
): Promise<DeskDecision> {
  if (task.kind !== 'approval' || task.subjectType !== 'approval' || !task.subjectId) {
    return { ok: false, error: 'That task is not an approval', status: 400 }
  }
  const approval = await deps.store.getApproval(task.subjectId)
  if (!approval) return { ok: false, error: 'That approval no longer exists', status: 409 }
  if (user.role !== approval.approverRole) return { ok: false, error: `Only the ${approval.approverRole} can decide sales orders`, status: 403 }
  const decider = { userId: user.id, name: user.name, role: user.role }
  if (action === 'stop') return { ok: true, message: await stopGroupSend(deps, decider, approval.id) }
  let decision: Decision
  if (action === 'approve') decision = await approveSalesOrder(deps, approval, decider, { via: 'desk', channel: 'desk' })
  else if (action === 'send_back') decision = await sendBackSalesOrder(deps, approval, decider, note, { via: 'desk', channel: 'desk' })
  else decision = await rejectSalesOrder(deps, approval, decider, note)
  if (!decision.ok) return { ok: false, error: decision.text ?? 'It is no longer waiting for a decision', status: 409 }
  return { ok: true, message: decision.text }
}

import type { AgentDeps } from '../agent/deps'
import { CANCELLABLE_SO_STATUSES, type Approval, type ApprovalVia, type Role } from '../db/types'
import { holderForRole } from '../domain/routing'
import { createTaskAndNotify } from '../tasks/service'
import { JOB_SO_GROUP, JOB_SO_RENDER, SEND_WINDOW_MS, customerGroupFor, groupJobKey, groupSendKey, groupWithSendOff } from './po-to-so'
import { approvedEcho } from './so-text'

/**
 * The admin's decisions on a sales order. Every path ends in one conditional update of the approval row (still
 * pending, still this version), so a second 👍, a 👍 on an old version or two channels at once change nothing.
 * Approve: the customer copy is scheduled 60 s later; *stop* in that window cancels it and puts the approval back.
 * Send back: the order goes back to draft, the office revises it, and the next version is a new approval.
 * Reject: desk only.
 */

export const GROUP_SEND_ATTEMPTS = 8

export type Decider = { userId: string; name: string; role: Role }

export type Decision = { ok: true; text: string; approval: Approval } | { ok: false; text: string | null }

function onlyApprover(approval: Approval): string {
  return `Only the ${approval.approverRole} can approve sales orders.`
}

export async function approveSalesOrder(
  deps: AgentDeps,
  approval: Approval,
  decider: Decider,
  how: { via: ApprovalVia; channel: 'whatsapp' | 'desk' },
): Promise<Decision> {
  if (decider.role !== approval.approverRole) return { ok: false, text: onlyApprover(approval) }
  const order = await deps.store.getSalesOrder(approval.subjectId)
  if (!order) return { ok: false, text: null }
  if (order.version !== approval.version || approval.status !== 'pending') {
    return { ok: false, text: approval.status === 'approved' ? `${order.docNo} is already approved.` : null }
  }
  const at = deps.now().toISOString()
  const decided = await deps.store.transitionApproval(approval.id, approval.version, 'pending', {
    status: 'approved',
    decidedBy: decider.userId,
    decidedAt: at,
    via: how.via,
    channel: how.channel,
  })
  if (!decided) return { ok: false, text: null }
  await deps.store.updateSalesOrder(order.id, { status: 'approved', approvedBy: decider.userId, approvedAt: at }, ['pending_approval'])
  const group = await customerGroupFor(deps, order)
  await deps.enqueue({
    kind: JOB_SO_GROUP,
    payload: { approvalId: decided.id },
    runAfter: new Date(Date.parse(at) + SEND_WINDOW_MS),
    idempotencyKey: groupJobKey(decided),
    maxAttempts: GROUP_SEND_ATTEMPTS,
  })
  console.log(`${order.docNo} approved by ${decider.name} via ${how.via} (${how.channel})`)
  const off = group ? null : await groupWithSendOff(deps, order)
  return { ok: true, approval: decided, text: approvedEcho(order, group?.subject ?? null, SEND_WINDOW_MS / 1000, decided.selfRaised, off) }
}

/**
 * *stop*: cancels a customer copy still inside its window and puts the approval back to pending. Once the send has
 * started (its registry row exists, even if the job is waiting to retry) it is too late: the copy may be in the group.
 */
export async function stopGroupSend(deps: AgentDeps, decider: Decider, approvalId?: string): Promise<string> {
  const approved = (await deps.store.listApprovals({ status: 'approved', subjectType: 'sales_order', limit: 20 })).filter(
    (approval) => !approvalId || approval.id === approvalId,
  )
  let started: Approval | null = null
  for (const approval of approved) {
    if (await deps.store.findOutbound(groupSendKey(approval))) {
      const recent = approval.decidedAt && deps.now().getTime() - Date.parse(approval.decidedAt) < 10 * 60_000
      if (recent && !started) started = approval
      continue
    }
    if (!(await deps.store.cancelQueuedJobs(JOB_SO_GROUP, { approvalId: approval.id }))) continue
    const order = await deps.store.getSalesOrder(approval.subjectId)
    await deps.store.transitionApproval(approval.id, approval.version, 'approved', {
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      via: null,
      channel: null,
    })
    if (order) await deps.store.updateSalesOrder(order.id, { status: 'pending_approval', approvedBy: null, approvedAt: null }, ['approved'])
    console.log(`${order?.docNo ?? approval.subjectId} send stopped by ${decider.name}`)
    return `Stopped. ${order?.docNo ?? 'The sales order'} was not sent and is waiting for approval again.`
  }
  if (started) {
    const order = await deps.store.getSalesOrder(started.subjectId)
    return `Too late — ${order?.docNo ?? 'that sales order'} was already being sent to the customer group.`
  }
  const recent = approved.find((approval) => approval.decidedAt && deps.now().getTime() - Date.parse(approval.decidedAt) < 10 * 60_000)
  if (recent) {
    const order = await deps.store.getSalesOrder(recent.subjectId)
    return `Too late to stop: ${order?.docNo ?? 'that sales order'} has already gone to the customer group.`
  }
  return 'Nothing is waiting to be sent.'
}

/** "send back: <note>": back to draft; the office revises it and the next version comes back for approval. */
export async function sendBackSalesOrder(
  deps: AgentDeps,
  approval: Approval,
  decider: Decider,
  note: string,
  how: { via: ApprovalVia; channel: 'whatsapp' | 'desk' },
): Promise<Decision> {
  if (decider.role !== approval.approverRole) return { ok: false, text: `Only the ${approval.approverRole} can send back sales orders.` }
  const order = await deps.store.getSalesOrder(approval.subjectId)
  if (!order || order.version !== approval.version) return { ok: false, text: null }
  const decided = await deps.store.transitionApproval(approval.id, approval.version, 'pending', {
    status: 'sent_back',
    decidedBy: decider.userId,
    decidedAt: deps.now().toISOString(),
    note: note || null,
    via: how.via,
    channel: how.channel,
  })
  if (!decided) return { ok: false, text: `${order.docNo} is not waiting for approval.` }
  await deps.store.updateSalesOrder(order.id, { status: 'draft' }, ['pending_approval'])
  if (approval.taskId) await deps.store.updateTaskStatus(approval.taskId, 'cancelled')
  await createTaskAndNotify(deps, {
    title: `Revise ${order.docNo}: ${note || 'sent back by the admin'}`.slice(0, 200),
    category: 'operations',
    kind: 'review',
    assigneeRole: 'office',
    description: `The admin sent ${order.docNo} (version ${order.version}) back${note ? `: “${note}”` : ''}. Make the change, then mark this task done: version ${order.version + 1} goes back to the admin for approval.`,
    subjectType: 'sales_order_revision',
    subjectId: `${order.id}:v${order.version}`,
    createdVia: how.channel === 'desk' ? 'desk' : 'whatsapp',
    createdBy: decider.userId,
  })
  return {
    ok: true,
    approval: decided,
    text: `Sent back ${order.docNo}${note ? `: “${note}”` : ''}. The office will revise it; version ${order.version + 1} comes back to you for approval.`,
  }
}

/** The revision task is done: the next version is rendered and goes back for approval (a new approval row). */
export async function reviseSalesOrder(deps: AgentDeps, salesOrderId: string, fromVersion: number): Promise<void> {
  const order = await deps.store.getSalesOrder(salesOrderId)
  if (!order || order.version !== fromVersion || order.status !== 'draft') return
  const next = await deps.store.updateSalesOrder(order.id, { status: 'pending_approval', version: fromVersion + 1 }, ['draft'])
  if (!next) return
  await deps.enqueue({
    kind: JOB_SO_RENDER,
    payload: { salesOrderId: next.id, version: next.version },
    idempotencyKey: `${JOB_SO_RENDER}:${next.id}:v${next.version}`,
  })
}

/** Reject (desk only): the order is dead, its reservations and requests released, its tasks cancelled. */
export async function rejectSalesOrder(deps: AgentDeps, approval: Approval, decider: Decider, note: string): Promise<Decision> {
  if (decider.role !== approval.approverRole) return { ok: false, text: `Only the ${approval.approverRole} can reject sales orders.` }
  const order = await deps.store.getSalesOrder(approval.subjectId)
  if (!order) return { ok: false, text: null }
  const decided = await deps.store.transitionApproval(approval.id, approval.version, 'pending', {
    status: 'rejected',
    decidedBy: decider.userId,
    decidedAt: deps.now().toISOString(),
    note: note || null,
    via: 'desk',
    channel: 'desk',
  })
  if (!decided) return { ok: false, text: `${order.docNo} is not waiting for approval.` }
  await deps.store.updateSalesOrder(order.id, { status: 'rejected' })
  await deps.store.cancelTasksForSubject('sales_order', order.id)
  if (approval.taskId) await deps.store.updateTaskStatus(approval.taskId, 'cancelled')
  await deps.store.closeProcurementRequests(order.id, 'cancelled')
  return { ok: true, approval: decided, text: `Rejected ${order.docNo}${note ? `: ${note}` : ''}.` }
}

/**
 * Cancel a TSO (admin, desk): it stops reserving stock, its open tasks and procurement requests are cancelled, a
 * pending approval is withdrawn and a customer copy still in its 60 s window is not sent. One already in the group
 * cannot be called back: the reply says so. TSOs already in SAP, rejected or cancelled cannot be cancelled here.
 */
export async function cancelSalesOrder(
  deps: AgentDeps,
  salesOrderId: string,
  decider: Decider,
  note: string,
): Promise<{ ok: true; text: string } | { ok: false; text: string; status: 403 | 404 | 409 }> {
  if (decider.role !== 'admin') return { ok: false, text: 'Only the admin can cancel a sales order.', status: 403 }
  const order = await deps.store.getSalesOrder(salesOrderId)
  if (!order) return { ok: false, text: 'Sales order not found.', status: 404 }
  if (!CANCELLABLE_SO_STATUSES.includes(order.status)) {
    const why = order.status === 'in_sap' ? `it is already in SAP as ${order.sapDocNo ?? 'a sales order'}; cancel it there` : `it is ${order.status.replace(/_/g, ' ')}`
    return { ok: false, text: `${order.docNo} cannot be cancelled: ${why}.`, status: 409 }
  }
  const cancelled = await deps.store.updateSalesOrder(order.id, { status: 'cancelled', cancelledAt: deps.now().toISOString() }, CANCELLABLE_SO_STATUSES)
  if (!cancelled) return { ok: false, text: `${order.docNo} changed meanwhile; try again.`, status: 409 }
  let alreadySent = order.status === 'sent'
  for (const approval of await deps.store.listApprovals({ subjectType: 'sales_order', subjectId: order.id })) {
    if (approval.status === 'pending') {
      await deps.store.transitionApproval(approval.id, approval.version, 'pending', { status: 'superseded', note: note || 'sales order cancelled' })
    }
    if (approval.status === 'approved') {
      await deps.store.cancelQueuedJobs(JOB_SO_GROUP, { approvalId: approval.id })
      if (await deps.store.findOutbound(groupSendKey(approval))) alreadySent = true
    }
    if (approval.taskId) {
      const task = await deps.store.getTask(approval.taskId)
      if (task && (task.status === 'todo' || task.status === 'doing')) await deps.store.updateTaskStatus(task.id, 'cancelled')
    }
  }
  await deps.store.cancelTasksForSubject('sales_order', order.id)
  await deps.store.cancelTasksForSubject('sales_order_revision', `${order.id}:v${order.version}`)
  if (order.customerPoId) await deps.store.cancelTasksForSubject('customer_po', order.customerPoId)
  await deps.store.closeProcurementRequests(order.id, 'cancelled')
  console.log(`${order.docNo} cancelled by ${decider.name}${note ? `: ${note}` : ''}`)
  return {
    ok: true,
    text: `Cancelled ${order.docNo}${note ? `: ${note}` : ''}. Its stock is free again and its tasks and requests are cancelled.${
      alreadySent ? ' The customer copy had already gone to the group: tell the customer.' : ''
    }`,
  }
}

/** The approvals a bare "approve" could mean: pending, current version. */
export async function pendingApprovals(deps: AgentDeps): Promise<Approval[]> {
  const pending = await deps.store.listApprovals({ status: 'pending', subjectType: 'sales_order', limit: 50 })
  const current: Approval[] = []
  for (const approval of pending) {
    const order = await deps.store.getSalesOrder(approval.subjectId)
    if (order && order.version === approval.version && order.status === 'pending_approval') current.push(approval)
  }
  return current
}

export function approverOf(accounts: Awaited<ReturnType<AgentDeps['store']['listAccountLinks']>>) {
  return holderForRole(accounts, 'admin')
}

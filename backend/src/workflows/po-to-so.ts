import { randomUUID } from 'node:crypto'
import type { AgentDeps } from '../agent/deps'
import { deskThreadJid, postToDesk } from '../agent/outbox'
import { dmAddress, ensureTierraPrefix, phoneJid, sendDm, sendDocument } from '../agent/send'
import type {
  AccountLink,
  Approval,
  CustomerPo,
  InventoryCheck,
  NewProcurementRequest,
  SalesOrder,
  TaskRecord,
} from '../db/types'
import { holderForRole } from '../domain/routing'
import { buildSalesOrder, hsnWarnings, totalMismatch } from '../domain/tso'
import { renderAnnexPdf } from '../pdf/availability-annex'
import { renderSalesOrderPdf, salesOrderFileName, type SoStamp } from '../pdf/sales-order'
import { cardInfo } from '../queries/po'
import { itemTax, partyCard } from '../queries/tso'
import { createTaskAndNotify } from '../tasks/service'
import { describePoSource, runInventoryCheck } from './po-intake'
import { checkText, shortDay } from './po-text'
import {
  approvalSummary,
  customerFollowupDescription,
  customerFollowupTitle,
  customerShortLines,
  expediteLines,
  makeText,
  procurementTaskDescription,
  procurementTaskTitle,
  shortageLines,
  shortHoldDescription,
  shortHoldTitle,
} from './so-text'

/**
 * PO -> TSO -> approval -> customer group (plan §P4, po-flow.md §9), as jobs. Every step can run twice (a worker
 * killed mid-job is re-run) without a second TSO, request, task or approval: each insert is guarded by a unique key,
 * and the TSO number is taken in the TSO's own transaction. The customer-group send is at most once: its registry
 * row is written (sending) before the call and never resent; a row stuck in sending becomes uncertain and the office
 * checks by hand.
 *
 * Jobs: po.process (raise the TSO, or hold the PO short), po.recheck (after procurement), so.render_pdf (SO + annex,
 * approval row, admin task), so.send_for_approval (to the admin), so.send_to_group (the customer copy, 60 s after
 * approval).
 */

export const JOB_PO_PROCESS = 'po.process'
export const JOB_PO_RECHECK = 'po.recheck'
export const JOB_SO_RENDER = 'so.render_pdf'
export const JOB_SO_ASK = 'so.send_for_approval'
export const JOB_SO_GROUP = 'so.send_to_group'

const PROCESS_DELAY_MS = 2_000

/** The admin's window to say *stop* before the customer copy goes out. */
export const SEND_WINDOW_MS = 60_000
/** A group send still marked sending after this long is uncertain: someone checks the group by hand. */
export const SENDING_STALE_MS = 60_000

export type FlowDeps = AgentDeps

function istDay(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(at)
}

/** Who system tasks are raised by: the person who sent the PO, else the admin, else anyone. */
function raiser(accounts: AccountLink[], po: CustomerPo | null): string | null {
  return po?.raisedBy ?? holderForRole(accounts, 'admin')?.id ?? accounts[0]?.id ?? null
}

async function partyLabel(deps: FlowDeps, partyGroupId: string | null, cardCode: string | null): Promise<string> {
  if (partyGroupId) {
    const group = await deps.store.getPartyGroup(partyGroupId)
    if (group) return group.alias || group.name
  }
  if (cardCode) {
    const alias = (await deps.store.listPartyAliases()).find((row) => row.cardCode === cardCode)
    if (alias) return alias.alias
    const info = (await cardInfo(deps.sapSql, [cardCode]).catch(() => ({}) as Record<string, never>))[cardCode]
    if (info) return info.cardName
  }
  return cardCode ?? 'the customer'
}

/** The customer group a TSO's customer copy goes to: mapped to its party group, with send_so on. */
export async function customerGroupFor(deps: FlowDeps, order: Pick<SalesOrder, 'partyGroupId'>): Promise<{ jid: string; subject: string } | null> {
  if (!order.partyGroupId) return null
  const group = (await deps.store.listWaGroups()).find((row) => row.partyGroupId === order.partyGroupId && row.sendSo)
  return group ? { jid: group.jid, subject: group.subject ?? group.jid } : null
}

/** A group mapped to the party with sales orders switched off (send_so false): nothing goes there by design. */
export async function groupWithSendOff(deps: FlowDeps, order: Pick<SalesOrder, 'partyGroupId'>): Promise<string | null> {
  if (!order.partyGroupId) return null
  const groups = (await deps.store.listWaGroups()).filter((row) => row.partyGroupId === order.partyGroupId)
  if (!groups.length || groups.some((row) => row.sendSo)) return null
  return groups[0]!.subject ?? groups[0]!.jid
}

// ------------------------------------------------------------------------------------------------ entry points

/**
 * The P3 seam: a PO has been checked (and, for a repeat, the admin said *proceed*). Queues po.process and says what
 * happens next, for the admin's summary.
 */
export async function queuePoProcess(deps: FlowDeps, po: CustomerPo, check: InventoryCheck): Promise<string> {
  await deps.store.updateCustomerPo(po.id, { status: check.verdict === 'fail' ? 'short' : 'checked' })
  await deps.enqueue({
    kind: JOB_PO_PROCESS,
    payload: { customerPoId: po.id, checkId: check.id },
    // a moment later, so the admin reads the PO summary before the approval request
    runAfter: new Date(deps.now().getTime() + PROCESS_DELAY_MS),
    idempotencyKey: `${JOB_PO_PROCESS}:${po.id}:${check.id}`,
  })
  if (check.verdict === 'fail') {
    if (!shortageLines(check).length && customerShortLines(check).length) {
      return "The customer's own material is short, so no sales order yet. The manager will ask the customer for it; the PO is checked again when it is in."
    }
    return 'Materials are short, so no sales order yet. The manager gets a procurement task; the PO is checked again when it is done.'
  }
  return 'Raising the sales order now; the approval request follows with the SO PDF.'
}

export async function processPo(deps: FlowDeps, customerPoId: string, checkId: string | null): Promise<void> {
  const po = await deps.store.getCustomerPo(customerPoId)
  if (!po || po.status === 'cancelled' || po.status === 'needs_review' || po.status === 'awaiting_proceed') return
  const check = checkId ? await deps.store.getInventoryCheck(checkId) : await deps.store.latestInventoryCheck(po.id)
  if (!check) return
  if (check.verdict === 'fail') {
    await holdShort(deps, po, check)
    return
  }
  await raiseSalesOrder(deps, po, check)
}

// ------------------------------------------------------------------------------------------------ pass: the TSO

/** A TSO that would be wrong (no GSTIN, a line without an item or pieces) is not raised: the PO goes to the office. */
async function blockSalesOrder(deps: FlowDeps, po: CustomerPo, problems: string[]): Promise<void> {
  const reason = `No sales order was raised: ${problems.join(' ')}`
  await deps.store.updateCustomerPo(po.id, { status: 'needs_review', reviewReason: reason })
  const accounts = await deps.store.listAccountLinks()
  const createdBy = raiser(accounts, po)
  if (createdBy) {
    await createTaskAndNotify(deps, {
      title: `Review PO ${po.poNo ?? '(no number)'}: no sales order yet`,
      category: 'operations',
      kind: 'review',
      assigneeRole: 'office',
      description: `${reason} Fix it (in SAP, or on the PO page under Orders → Intake), then "Confirm and check" the PO there.`,
      subjectType: 'customer_po',
      subjectId: po.id,
      createdVia: 'system',
      createdBy,
      reopen: true,
    })
  }
  const admin = holderForRole(accounts, 'admin')
  const text = `PO ${po.poNo ?? '(no number)'}: no sales order yet. ${problems.join(' ')} The office has a review task.`
  const subject = { subjectType: 'customer_po', subjectId: po.id }
  if (admin?.phoneNumber) {
    await sendDm(deps, admin.phoneNumber, text, { purpose: 'po_summary', ...subject }).catch((error: unknown) => console.error('Could not tell the admin', error))
  } else if (admin) {
    await postToDesk(deps.store, deskThreadJid(admin.id), ensureTierraPrefix(text), subject)
  }
  console.warn(`TSO for PO ${po.poNo} (${po.id}) blocked: ${problems.join(' ')}`)
}

async function raiseSalesOrder(deps: FlowDeps, po: CustomerPo, check: InventoryCheck): Promise<SalesOrder | null> {
  const accounts = await deps.store.listAccountLinks()
  const codes = po.lines.map((line) => line.itemCode).filter((code): code is string => Boolean(code))
  const [tax, card] = await Promise.all([
    itemTax(deps.sapSql, codes),
    po.cardCode ? cardInfo(deps.sapSql, [po.cardCode]).then((rows) => rows[po.cardCode!]) : Promise.resolve(undefined),
  ])
  const built = buildSalesOrder({
    po,
    check,
    tax,
    cardGstin: card?.gstin ?? null,
    docDate: istDay(deps.now()),
    createdBy: po.raisedBy,
  })
  if (built.problems.length && !(await deps.store.findSalesOrderForPo(po.id))) {
    await blockSalesOrder(deps, po, built.problems)
    return null
  }
  const { order, created } = await deps.store.createSalesOrder(built.order, built.numbering)
  if (created) console.log(`raised ${order.docNo} for PO ${po.poNo} (${po.id})`)
  await deps.store.updateCustomerPo(po.id, { status: 'checked' })

  // procurement: make what is not in stock, expedite what is short now but on order
  const requests: NewProcurementRequest[] = [
    ...check.lines
      .filter((line) => line.kind === 'fg' && (line.toMake ?? 0) > 0)
      .map((line) => request(order, po, line.itemCode, line.itemName, line.toMake ?? 0, 'pcs', 'production', `make for ${order.docNo}`)),
    ...expediteLines(check).map((line) =>
      request(order, po, line.itemCode, line.itemName, line.shortNow, line.uom, 'expedite', `on ${line.incoming.slice(0, 2).join(', ') || 'open POs'}`),
    ),
  ]
  await deps.store.createProcurementRequests(requests)

  const createdBy = raiser(accounts, po)
  if (createdBy) {
    await createTaskAndNotify(deps, {
      title: procurementTaskTitle(order, check),
      category: 'procurement',
      kind: 'procurement',
      assigneeRole: 'manager',
      description: procurementTaskDescription(order, po, check, await partyLabel(deps, order.partyGroupId, order.cardCode)),
      dueAt: po.deliveryDate ? new Date(`${po.deliveryDate}T10:00:00+05:30`) : null,
      subjectType: 'sales_order',
      subjectId: order.id,
      createdVia: 'system',
      createdBy,
    })
    await raiseCustomerFollowup(deps, po, check, createdBy)
  }
  await deps.enqueue({
    kind: JOB_SO_RENDER,
    payload: { salesOrderId: order.id, version: order.version },
    idempotencyKey: `${JOB_SO_RENDER}:${order.id}:v${order.version}`,
  })
  return order
}

function request(
  order: SalesOrder | null,
  po: CustomerPo,
  itemCode: string,
  itemName: string | null,
  qtyNeeded: number,
  uom: string | null,
  reason: NewProcurementRequest['reason'],
  note: string | null,
): NewProcurementRequest {
  return {
    subjectType: order ? 'sales_order' : 'customer_po',
    subjectId: order ? order.id : po.id,
    customerPoId: po.id,
    salesOrderId: order?.id ?? null,
    itemCode,
    itemName,
    qty: qtyNeeded,
    uom,
    reason,
    taskId: null,
    note,
  }
}

/** Customer-supplied materials that are short: a follow-up task, never a purchase. */
async function raiseCustomerFollowup(deps: FlowDeps, po: CustomerPo, check: InventoryCheck, createdBy: string): Promise<TaskRecord | null> {
  const lines = customerShortLines(check)
  if (!lines.length) return null
  const owner = lines[0]!
  const label = owner.ownerName ?? (await partyLabel(deps, po.partyGroupId, owner.ownerCardCode ?? po.cardCode))
  const { task } = await createTaskAndNotify(deps, {
    title: customerFollowupTitle(po, check, label),
    category: 'procurement',
    kind: 'customer_followup',
    assigneeRole: 'manager',
    description: customerFollowupDescription(po, check, label),
    subjectType: 'customer_po',
    subjectId: po.id,
    createdVia: 'system',
    createdBy,
  })
  return task
}

// ------------------------------------------------------------------------------------------------ fail: SHORT_HOLD

async function holdShort(deps: FlowDeps, po: CustomerPo, check: InventoryCheck): Promise<void> {
  await deps.store.updateCustomerPo(po.id, { status: 'short' })
  const accounts = await deps.store.listAccountLinks()
  const requests: NewProcurementRequest[] = [
    ...shortageLines(check).map((line) =>
      request(null, po, line.itemCode, line.itemName, line.shortAfterIncoming, line.uom, 'shortage', 'short even after open purchase orders'),
    ),
    ...expediteLines(check).map((line) =>
      request(null, po, line.itemCode, line.itemName, line.shortNow, line.uom, 'expedite', `on ${line.incoming.slice(0, 2).join(', ') || 'open POs'}`),
    ),
  ]
  await deps.store.createProcurementRequests(requests)
  const createdBy = raiser(accounts, po)
  if (!createdBy) return
  if (shortageLines(check).length || expediteLines(check).length) {
    const party = await partyLabel(deps, po.partyGroupId, po.cardCode)
    await createTaskAndNotify(deps, {
      title: shortHoldTitle(po, check, party),
      category: 'procurement',
      kind: 'procurement',
      assigneeRole: 'manager',
      description: shortHoldDescription(po, check, party),
      subjectType: 'customer_po',
      subjectId: po.id,
      createdVia: 'system',
      createdBy,
    })
  }
  await raiseCustomerFollowup(deps, po, check, createdBy)
}

/**
 * The manager finished the procurement (or customer follow-up) task of a PO on hold: check it again. Pass: on to the
 * TSO. Still short: the manager hears what is missing and the task is open again.
 */
export async function recheckPo(deps: FlowDeps, customerPoId: string, taskId: string | null): Promise<void> {
  const po = await deps.store.getCustomerPo(customerPoId)
  if (!po || po.status !== 'short') return
  if (await deps.store.findSalesOrderForPo(po.id)) return
  const requested = po.lines
    .filter((line) => line.itemCode && line.pcs != null)
    .map((line) => ({ itemCode: line.itemCode!, pcs: line.pcs! }))
  const check = await runInventoryCheck(deps, requested, { customerPoId: po.id, kind: 'po', createdBy: null })
  if (check.verdict !== 'fail') {
    await deps.store.closeProcurementRequests(po.id, 'done')
    await queuePoProcess(deps, po, check)
    return
  }
  const task = taskId ? await deps.store.getTask(taskId) : null
  if (task) await deps.store.updateTaskStatus(task.id, 'todo')
  const holder = task?.assigneeId ? (await deps.store.listAccountLinks()).find((account) => account.id === task.assigneeId) : null
  if (task && holder?.phoneNumber) {
    const text = [`PO ${po.poNo} is still short after the recheck, so the task is open again.`, '', ...checkText(check)].join('\n')
    await sendDm(deps, holder.phoneNumber, text, { purpose: 'task_notice', subjectType: 'task', subjectId: task.id })
  }
}

// ------------------------------------------------------------------------------------------------ PDFs and approval

async function soContext(deps: FlowDeps, order: SalesOrder) {
  const [po, check, customer] = await Promise.all([
    order.customerPoId ? deps.store.getCustomerPo(order.customerPoId) : Promise.resolve(null),
    order.checkId ? deps.store.getInventoryCheck(order.checkId) : Promise.resolve(null),
    partyCard(deps.sapSql, order.cardCode).catch(() => null),
  ])
  return { po, check, customer }
}

/** Renders (once) and stores the customer copy of a TSO version with a stamp. Returns the stored document id. */
export async function storeSoPdf(deps: FlowDeps, order: SalesOrder, stamp: SoStamp): Promise<{ id: string; content: Buffer; fileName: string }> {
  const kind = stamp.kind === 'approved' ? 'approved' : stamp.kind === 'draft' ? 'draft' : 'pending'
  const fileName = salesOrderFileName(order.docNo, order.version, kind)
  const existing = (await deps.store.listDocuments('sales_order', order.id)).find((doc) => doc.kind === 'so_pdf' && doc.filename === fileName)
  if (existing) {
    const stored = await deps.store.getDocument(existing.id)
    if (stored) return { id: existing.id, content: stored.content, fileName }
  }
  const { po, customer } = await soContext(deps, order)
  const content = await renderSalesOrderPdf({ order, customer, buyerName: po?.buyerName ?? null, stamp, now: deps.now() })
  const id = await deps.store.insertDocument({
    filename: fileName,
    mimeType: 'application/pdf',
    content,
    kind: 'so_pdf',
    subjectType: 'sales_order',
    subjectId: order.id,
    version: order.version,
  })
  return { id, content, fileName }
}

async function storeAnnex(deps: FlowDeps, order: SalesOrder): Promise<{ id: string; content: Buffer; fileName: string }> {
  const fileName = salesOrderFileName(order.docNo, order.version, 'annex')
  const existing = (await deps.store.listDocuments('sales_order', order.id)).find((doc) => doc.kind === 'so_annex' && doc.version === order.version)
  if (existing) {
    const stored = await deps.store.getDocument(existing.id)
    if (stored) return { id: existing.id, content: stored.content, fileName: existing.filename }
  }
  const { po, check } = await soContext(deps, order)
  const [requests, tasks, customerName] = await Promise.all([
    deps.store.listProcurementRequests({ subjectId: order.id }),
    deps.store.listTasks(),
    partyLabel(deps, order.partyGroupId, order.cardCode),
  ])
  const card = (await cardInfo(deps.sapSql, [order.cardCode]).catch(() => ({}) as Record<string, never>))[order.cardCode]
  const source = po ? await describePoSource(deps, po) : null
  const warnings = [
    ...hsnWarnings(order.lines),
    ...(po ? [totalMismatch(order.total, po.total)].filter((line): line is string => Boolean(line)) : []),
    ...(source ? [`${source.line}.${source.warning ? ` ${source.warning.replace(/^⚠ /, '')}` : ''}`] : []),
    ...(po?.repeatOf.length ? [`Repeat PO: already seen as ${po.repeatOf.map((hit) => hit.docNo).join(', ')}; the admin said proceed.`] : []),
  ]
  const content = await renderAnnexPdf({
    order,
    po,
    check,
    customerName: card?.cardName ? `${customerName} — ${card.cardName}` : customerName,
    warnings,
    requests,
    tasks: tasks.filter(
      (task) =>
        task.status !== 'cancelled' &&
        ((task.subjectType === 'sales_order' && task.subjectId === order.id) ||
          (task.subjectType === 'customer_po' && task.subjectId === order.customerPoId)),
    ),
    now: deps.now(),
  })
  const id = await deps.store.insertDocument({
    filename: fileName,
    mimeType: 'application/pdf',
    content,
    kind: 'so_annex',
    subjectType: 'sales_order',
    subjectId: order.id,
    version: order.version,
  })
  return { id, content, fileName }
}

/** so.render_pdf: the SO (pending) and the annex for one version, the approval row and the admin's approval task. */
export async function renderForApproval(deps: FlowDeps, salesOrderId: string, version: number): Promise<void> {
  const order = await deps.store.getSalesOrder(salesOrderId)
  if (!order || order.version !== version || order.status !== 'pending_approval') return
  const [pdf, annex] = [await storeSoPdf(deps, order, { kind: 'pending' }), await storeAnnex(deps, order)]
  const accounts = await deps.store.listAccountLinks()
  const admin = holderForRole(accounts, 'admin')
  const po = order.customerPoId ? await deps.store.getCustomerPo(order.customerPoId) : null
  let approval = await deps.store.createApproval({
    subjectType: 'sales_order',
    subjectId: order.id,
    version: order.version,
    approverRole: 'admin',
    selfRaised: Boolean(admin && po?.raisedBy === admin.id),
    raisedBy: po?.raisedBy ?? null,
    soPdfId: pdf.id,
    annexId: annex.id,
  })
  if (!approval.soPdfId || !approval.annexId) {
    approval = (await deps.store.updateApproval(approval.id, { soPdfId: pdf.id, annexId: annex.id })) ?? approval
  }
  const createdBy = raiser(accounts, po)
  if (createdBy && !approval.taskId) {
    const { task } = await createTaskAndNotify(deps, {
      title: `Approve ${order.docNo} — ${await partyLabel(deps, order.partyGroupId, order.cardCode)}, ₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2 }).format(order.total)}`,
      category: 'administration',
      kind: 'approval',
      assigneeRole: 'admin',
      description: `Sales order ${order.docNo}${order.version > 1 ? ` version ${order.version}` : ''} for PO ${order.customerPoNo ?? '—'}. Approve or send back here or on WhatsApp.`,
      subjectType: 'approval',
      subjectId: approval.id,
      createdVia: 'system',
      createdBy,
    })
    await deps.store.updateApproval(approval.id, { taskId: task.id })
  }
  await deps.enqueue({ kind: JOB_SO_ASK, payload: { approvalId: approval.id }, idempotencyKey: `${JOB_SO_ASK}:${approval.id}` })
}

/** Registry purposes of the two approval messages: the SO PDF with the summary, and the internal annex. */
export const APPROVAL_REQUEST = 'approval_request'
export const APPROVAL_ANNEX = 'approval_annex'

/**
 * so.send_for_approval: one approval message to the admin (summary as the SO PDF's caption) and the annex. Each id is
 * recorded as soon as it is sent, so a retry (the worker died, the annex send failed) sends only what is missing, and
 * the chat pin and the task notice are always set once both are out.
 */
export async function sendForApproval(deps: FlowDeps, approvalId: string): Promise<void> {
  const approval = await deps.store.getApproval(approvalId)
  if (!approval || approval.status !== 'pending') return
  const order = await deps.store.getSalesOrder(approval.subjectId)
  if (!order || order.version !== approval.version) return
  const { po, check } = await soContext(deps, order)
  const accounts = await deps.store.listAccountLinks()
  const admin = holderForRole(accounts, 'admin')
  if (!admin) return
  const procurement = (await deps.store.listTasks()).find(
    (task) => task.subjectType === 'sales_order' && task.subjectId === order.id && task.kind === 'procurement' && task.status !== 'cancelled',
  )
  const group = await customerGroupFor(deps, order)
  const card = (await cardInfo(deps.sapSql, [order.cardCode]).catch(() => ({}) as Record<string, never>))[order.cardCode]
  const previous = order.version > 1
    ? (await deps.store.listApprovals({ subjectType: 'sales_order', subjectId: order.id })).find((row) => row.version === order.version - 1)
    : undefined
  const mismatch = po ? totalMismatch(order.total, po.total) : null
  const summary = approvalSummary({
    revisedAfter: previous?.status === 'sent_back' ? (previous.note ?? 'sent back') : null,
    order,
    po,
    check,
    approval,
    cardName: card?.cardName ?? null,
    procurementHolder: procurement?.assigneeName ?? null,
    group: group?.subject ?? null,
    source: po ? await describePoSource(deps, po) : null,
    warnings: mismatch ? [mismatch] : [],
  })
  const pdf = await storeSoPdf(deps, order, { kind: 'pending' })
  const annex = await storeAnnex(deps, order)
  const subject = { subjectType: 'approval', subjectId: approval.id }
  if (!admin.phoneNumber) {
    if (!approval.waMessageIds.length) {
      const links = `SO PDF: /api/documents/${pdf.id}\nAnnex (internal): /api/documents/${annex.id}`
      await postToDesk(deps.store, deskThreadJid(admin.id), ensureTierraPrefix(`${summary}\n\n${links}`), subject, APPROVAL_REQUEST)
      await deps.store.updateApproval(approval.id, { waMessageIds: [`desk:${approval.id}`] })
    }
    await deps.store.setChatContext(deskThreadJid(admin.id), 'approval', approval.id)
    return
  }
  const to = dmAddress(admin.phoneNumber)
  const ids = [...approval.waMessageIds]
  const sent = await Promise.all(ids.map((id) => deps.store.findMessage(id)))
  let main = sent.find((row) => row?.purpose === APPROVAL_REQUEST)?.evolutionMessageId ?? null
  // before annexes were registered on their own, both messages were approval_request: two ids means both went out
  const annexSent = sent.some((row) => row?.purpose === APPROVAL_ANNEX) || sent.filter((row) => row?.purpose === APPROVAL_REQUEST).length > 1
  if (!main) {
    main = await sendDocument(deps, to, { content: pdf.content, fileName: pdf.fileName, caption: summary }, { purpose: APPROVAL_REQUEST, ...subject })
    if (main) {
      ids.push(main)
      await deps.store.updateApproval(approval.id, { waMessageIds: ids })
    }
  }
  if (!annexSent) {
    const annexId = await sendDocument(
      deps,
      to,
      { content: annex.content, fileName: annex.fileName, caption: `Internal annex for ${order.docNo}: the availability check. Not for the customer.` },
      { purpose: APPROVAL_ANNEX, ...subject },
    )
    if (annexId) {
      ids.push(annexId)
      await deps.store.updateApproval(approval.id, { waMessageIds: ids })
    }
  }
  if (approval.taskId && main) await deps.store.markTaskNotified(approval.taskId, main, deps.now())
  await deps.store.setChatContext(phoneJid(admin.phoneNumber), 'approval', approval.id)
}

// ------------------------------------------------------------------------------------------------ the customer copy

export function groupSendKey(approval: Pick<Approval, 'id'>): string {
  return `so.group:${approval.id}`
}

/**
 * The job key of one scheduled send. Each approval decision schedules its own (a *stop* cancels it by payload); the
 * decision itself is single by the conditional update, and the send is single by groupSendKey.
 */
export function groupJobKey(approval: Pick<Approval, 'id' | 'decidedAt'>): string {
  return `${JOB_SO_GROUP}:${approval.id}:${approval.decidedAt ? Date.parse(approval.decidedAt) : 0}:${randomUUID().slice(0, 8)}`
}

async function officeTask(deps: FlowDeps, input: { title: string; description: string; subjectType: string; subjectId: string; kind?: 'todo' | 'review' }): Promise<void> {
  const accounts = await deps.store.listAccountLinks()
  const createdBy = holderForRole(accounts, 'admin')?.id ?? accounts[0]?.id
  if (!createdBy) return
  await createTaskAndNotify(deps, {
    title: input.title,
    category: 'administration',
    kind: input.kind ?? 'todo',
    assigneeRole: 'office',
    description: input.description,
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    createdVia: 'system',
    createdBy,
  })
}

async function tellAdmin(deps: FlowDeps, text: string, approval: Approval): Promise<void> {
  const admin = holderForRole(await deps.store.listAccountLinks(), 'admin')
  if (!admin) return
  const registry = { purpose: 'approval_update', subjectType: 'approval', subjectId: approval.id }
  if (admin.phoneNumber) {
    await sendDm(deps, admin.phoneNumber, text, registry).catch((error: unknown) => console.error('Could not tell the admin', error))
  } else {
    await postToDesk(deps.store, deskThreadJid(admin.id), ensureTierraPrefix(text), { subjectType: 'approval', subjectId: approval.id })
  }
}

/** The approval task is closed by the system once the decision is final, and the manager hears the TSO went out. */
async function closeAfterSend(deps: FlowDeps, order: SalesOrder, approval: Approval, where: string | null): Promise<void> {
  if (approval.taskId) {
    const task = await deps.store.getTask(approval.taskId)
    if (task && (task.status === 'todo' || task.status === 'doing')) await deps.store.updateTaskStatus(task.id, 'done')
  }
  const manager = holderForRole(await deps.store.listAccountLinks(), 'manager')
  if (manager?.phoneNumber) {
    const by = approval.decidedByName ?? 'the admin'
    const party = await partyLabel(deps, order.partyGroupId, order.cardCode)
    const text = where
      ? `${order.docNo} (${party}, PO ${order.customerPoNo ?? '—'}) was approved by ${by} and sent to ${where}.`
      : `${order.docNo} (${party}, PO ${order.customerPoNo ?? '—'}) was approved by ${by}.`
    await sendDm(deps, manager.phoneNumber, text, { purpose: 'so_update', subjectType: 'sales_order', subjectId: order.id }).catch(
      (error: unknown) => console.error('Could not tell the manager', error),
    )
  }
}

/**
 * so.send_to_group: the APPROVED customer copy, at most once, to the party's mapped group. Nothing mapped: an office
 * task to map one. The registry row is written before the send; a row found still sending is never resent.
 */
export async function sendToGroup(deps: FlowDeps, approvalId: string): Promise<void> {
  const approval = await deps.store.getApproval(approvalId)
  if (!approval || approval.status !== 'approved') return
  const order = await deps.store.getSalesOrder(approval.subjectId)
  if (!order || order.version !== approval.version || order.status !== 'approved') return
  const group = await customerGroupFor(deps, order)
  const party = await partyLabel(deps, order.partyGroupId, order.cardCode)
  if (!group) {
    // approved, but nothing went to the customer: never "sent"
    await deps.store.updateSalesOrder(order.id, { status: 'approved_unsent' }, ['approved'])
    const off = await groupWithSendOff(deps, order)
    if (off) {
      await tellAdmin(deps, `${order.docNo} is approved. Sales orders are switched off for *${off}*, so nothing was sent to the customer.`, approval)
      await closeAfterSend(deps, order, approval, null)
      return
    }
    // one task per sales order: a done task for an earlier TSO of the same party never swallows this one
    await officeTask(deps, {
      title: `Map WhatsApp group for ${party} and send ${order.docNo}`,
      description: `${order.docNo} is approved but no WhatsApp group is mapped to ${party} (with sales orders on), so the customer copy was not sent. Map the group in Settings and send ${order.docNo} to the customer by hand.`,
      subjectType: 'sales_order',
      subjectId: order.id,
    })
    await tellAdmin(
      deps,
      `${order.docNo} is approved, but nothing went to the customer: no WhatsApp group is mapped for ${party}. The office has a task to map one and send it by hand.`,
      approval,
    )
    await closeAfterSend(deps, order, approval, null)
    return
  }
  const key = groupSendKey(approval)
  const pdf = await storeSoPdf(deps, order, {
    kind: 'approved',
    by: approval.decidedByName ?? 'Admin',
    at: approval.decidedAt ?? deps.now().toISOString(),
  })
  const caption = ensureTierraPrefix(`Sales order ${order.docNo} for PO ${order.customerPoNo ?? '—'}${order.deliveryDate ? `, delivery ${shortDay(order.deliveryDate)}` : ''}.`)
  const existing = await deps.store.reserveOutbound({
    idempotencyKey: key,
    evolutionMessageId: `outbound:${key}`,
    remoteJid: group.jid,
    fromMe: true,
    hasPdf: true,
    body: caption,
    kind: 'document',
    purpose: 'so_customer_copy',
    subjectType: 'sales_order',
    subjectId: order.id,
    at: deps.now(),
  })
  if (existing) {
    // A send was started before (this job ran already). It is never repeated; what it got to decides the status.
    if (existing.status === 'sent') {
      // the send went out and the worker died before the order was updated
      if (await deps.store.updateSalesOrder(order.id, { status: 'sent', sentAt: deps.now().toISOString() }, ['approved'])) {
        await tellAdmin(deps, `Sent ${order.docNo} to *${group.subject}*.`, approval)
        await closeAfterSend(deps, order, approval, group.subject)
      }
      return
    }
    if (existing.status === 'sending' && deps.now().getTime() - Date.parse(existing.createdAt) < SENDING_STALE_MS) {
      throw new Error(`${order.docNo}: a send to the group may be in progress; checking again shortly`)
    }
    // sending for too long, uncertain or failed: nobody knows whether it reached the group
    if (existing.status === 'sending') await deps.store.setOutboundStatus(key, 'uncertain')
    await officeTask(deps, {
      title: `Check whether ${order.docNo} reached ${group.subject}`,
      description: `The bot started sending the approved ${order.docNo} to the WhatsApp group ${group.subject} but did not hear back. It is never resent automatically: look in the group and send it by hand if it is missing.`,
      subjectType: 'approval',
      subjectId: approval.id,
      kind: 'review',
    })
    if (await deps.store.updateSalesOrder(order.id, { status: 'approved_unsent' }, ['approved'])) {
      await tellAdmin(deps, `I could not confirm that ${order.docNo} reached *${group.subject}*. The office will check the group.`, approval)
      await closeAfterSend(deps, order, approval, null)
    }
    return
  }
  const sent = await deps.evolution.sendMedia({
    number: group.jid,
    mediatype: 'document',
    mimetype: 'application/pdf',
    fileName: pdf.fileName,
    caption,
    media: pdf.content.toString('base64'),
  })
  await deps.store.completeOutbound(key, sent.messageId)
  await deps.store.updateSalesOrder(order.id, { status: 'sent', sentAt: deps.now().toISOString() }, ['approved'])
  await tellAdmin(deps, `Sent ${order.docNo} to *${group.subject}*.`, approval)
  await closeAfterSend(deps, order, approval, group.subject)
}

/** For the agent and the dashboard: everything about one TSO. */
export async function salesOrderView(deps: FlowDeps, order: SalesOrder) {
  const [{ po, check }, approvals, requests, documents, tasks] = await Promise.all([
    soContext(deps, order),
    deps.store.listApprovals({ subjectType: 'sales_order', subjectId: order.id }),
    deps.store.listProcurementRequests({ subjectId: order.id }),
    deps.store.listDocuments('sales_order', order.id),
    deps.store.listTasks(),
  ])
  const approvalIds = new Set(approvals.map((approval) => approval.id))
  return {
    order,
    po,
    check,
    approvals,
    requests,
    documents,
    warnings: hsnWarnings(order.lines),
    tasks: tasks.filter(
      (task) =>
        (task.subjectType === 'sales_order' && task.subjectId === order.id) ||
        (task.subjectType === 'approval' && approvalIds.has(task.subjectId ?? '')) ||
        (task.subjectType === 'customer_po' && task.subjectId === order.customerPoId),
    ),
    make: check ? makeText(check) : [],
  }
}


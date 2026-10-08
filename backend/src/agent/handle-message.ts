import { randomUUID } from 'node:crypto'
import { bananaRequirement, type BananaRequirement } from '../domain/banana'
import {
  adminOnlyReply,
  confirmationChoice,
  declinedReply,
  samePoNumber,
  whichPoReply,
  type ConfirmationChoice,
} from '../domain/confirm'
import { availabilityMap, dashboardSnapshot } from '../domain/reads'
import {
  createdReply,
  decideIntake,
  formatKg,
  lineFailureReply,
  noInventoryReply,
  procureQuantity,
  shortReply,
  shortStockReply,
  type ExtractedPo,
  type Shortage,
} from '../domain/intake'
import { holderForRole, holderLabel, resolveAssignee, type Assignment } from '../domain/routing'
import { RAW_BANANA_ITEM_ID } from '../db/seed-data'
import {
  DESK_THREAD_PREFIX,
  type AccountLink,
  type NewJob,
  type PendingConfirmation,
  type ProductionPlan,
  type TaskRecord,
} from '../db/types'
import { CustomerInventory, StockShortError } from '../domain/inventory'
import type { Store } from '../db/store'
import { renderTestPdf } from '../pdf/test-doc'
import { canFinish, isDoneEmoji, isDoneText, isOpenTask } from '../tasks/done'
import { completeTask, createTaskAndNotify } from '../tasks/service'
import { ExtractError } from './extract'
import type { TaskExtraction, TaskExtractInput } from './extract-task'
import type { JudgeInput, JudgeResult } from './judge'
import type { ChatInput, ChatTurn } from './reply'
import { TIERRA_HEADER, ensureTierraPrefix, isTierraReply, phoneJid, sendDm, tierraReplyText } from './send'
import type { EvolutionClient } from '../whatsapp/evolution'
import { resolvePeople, type Person } from '../whatsapp/people'
import { phoneDigits } from '../whatsapp/qr'
import {
  deliveryAddress,
  replyChatJid,
  type BotMode,
  type ChatKind,
  type IncomingMessage,
} from '../whatsapp/parse'

export { ensureTierraPrefix, isTierraReply, tierraReplyText }

export type AgentDeps = {
  store: Store
  evolution: EvolutionClient
  extractPurchaseOrder: (pdf: Buffer) => Promise<ExtractedPo>
  judgeIntent: (input: JudgeInput) => Promise<JudgeResult>
  extractTask: (input: TaskExtractInput) => Promise<TaskExtraction>
  completeChat: (input: ChatInput) => Promise<string>
  /** Queues background work (WhatsApp turns, task notices). False when that idempotency key was already queued. */
  enqueue: (job: NewJob) => Promise<boolean>
  botMode: BotMode
  now: () => Date
}

const PDF_UNAVAILABLE = 'The PDF could not be downloaded. No order was created.'
const READ_EMOJI = '👀'
const INTENT_CONFIDENCE_FLOOR = 0.5
const UNDECIDED = 'Tierra Bot cannot decide yet.'
const NEED_PDF = 'Send the purchase-order PDF and Tierra Bot will read it.'
const NEED_CATEGORY =
  'Which category should this task use? Administration, operations, quality, procurement, production, dispatch, or finance.'
const UNKNOWN_ASSIGNEE = 'I could not match that person to a Tierra account, so no task was added.'
const NEED_TITLE = 'What should the task be called?'
const NEED_ACCOUNT = 'A Tierra account has to add the task.'
const HERE = 'Tierra Bot is here.'
const TEST_PDF = /^test\s+pdf[.!]?$/i

export type DeskContext = {
  speaker: Person
}

export function deskThreadJid(userId: string): string {
  return `${DESK_THREAD_PREFIX}${userId}`
}

export function isDeskThread(remoteJid: string): boolean {
  return remoteJid.startsWith(DESK_THREAD_PREFIX)
}

function taskReply(task: TaskRecord, assignment: Assignment, mentionPhone: string | null): string {
  if (!task.assigneeId) return `Added "${task.title}" under ${task.category}. It is unassigned.`
  return `Added "${task.title}" under ${task.category}, assigned to ${holderLabel(assignment, mentionPhone)}.`
}

function mentionTargets(message: IncomingMessage, phones: string[]): string[] {
  return isDeskThread(replyChatJid(message)) ? [] : phones
}

/** What a bot message is about, so a reply to it can be traced back. */
type Subject = { subjectType: string; subjectId: string }

async function sendBotText(
  deps: AgentDeps,
  message: IncomingMessage,
  text: string,
  mentionPhones: string[] = [],
  subject?: Subject,
): Promise<string> {
  const remoteJid = replyChatJid(message)
  const body = ensureTierraPrefix(text)
  if (isDeskThread(remoteJid)) {
    await postToDesk(deps.store, remoteJid, body, subject)
    return body
  }
  const sent = await deps.evolution.sendText(deliveryAddress(remoteJid), body, mentionPhones)
  if (!sent.messageId) return body
  await deps.store.claimMessage({
    evolutionMessageId: sent.messageId,
    remoteJid,
    fromMe: true,
    hasPdf: false,
    body,
    kind: 'text',
    purpose: 'reply',
    status: 'sent',
    ...subject,
  })
  return body
}

async function postToDesk(store: Store, remoteJid: string, body: string, subject?: Subject): Promise<void> {
  await store.claimMessage({
    evolutionMessageId: `desk-out-${randomUUID()}`,
    remoteJid,
    fromMe: true,
    hasPdf: false,
    body,
    purpose: 'reply',
    ...subject,
  })
}

function pdfBuffer(message: IncomingMessage, downloaded: string | null): Buffer {
  const raw = message.embeddedBase64 ?? downloaded
  if (!raw) throw new ExtractError(PDF_UNAVAILABLE)
  const payload = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw
  return Buffer.from(payload, 'base64')
}

async function pdfBytes(deps: AgentDeps, message: IncomingMessage): Promise<Buffer> {
  let downloaded: string | null = null
  if (!message.embeddedBase64) {
    try {
      const media = await deps.evolution.downloadMedia(message.raw)
      downloaded = media.base64
    } catch (error) {
      if (error instanceof ExtractError) throw error
      throw new ExtractError(PDF_UNAVAILABLE)
    }
  }
  return pdfBuffer(message, downloaded)
}

function withSender(text: string, speaker: Person | null): string {
  if (!speaker) return text
  return `${text} From ${speaker.name}.`
}

/** Where details go when the chat itself must not see them: the admin's DM, or their desk without a phone. */
type AdminInbox = { userId: string; name: string; jid: string; phone: string | null }

function adminInbox(accounts: AccountLink[]): AdminInbox | null {
  const admin = holderForRole(accounts, 'admin')
  if (!admin) return null
  const jid = admin.phoneNumber ? phoneJid(admin.phoneNumber) : deskThreadJid(admin.id)
  return { userId: admin.id, name: admin.name, jid, phone: admin.phoneNumber }
}

async function tellAdmin(deps: AgentDeps, inbox: AdminInbox, text: string, subject?: Subject): Promise<void> {
  if (inbox.phone) {
    await sendDm(deps, inbox.phone, text, { purpose: 'intake_report', ...subject })
    return
  }
  await postToDesk(deps.store, inbox.jid, ensureTierraPrefix(text), subject)
}

function senderLabel(message: IncomingMessage, chatKind: ChatKind, speaker: Person | null): string {
  if (speaker) return speaker.name
  const jids =
    chatKind === 'group'
      ? [message.participantAltJid, message.participantJid]
      : [message.aliasJid, message.remoteJid]
  const phone = jids.find((jid) => jid?.endsWith('@s.whatsapp.net'))
  return phone ? `+${phoneDigits(phone)}` : 'an unknown number'
}

function intakeSource(message: IncomingMessage, chatKind: ChatKind, speaker: Person | null, fileName: string): string {
  const where = chatKind === 'group' ? ` in group ${message.remoteJid}` : ''
  return `${fileName} from ${senderLabel(message, chatKind, speaker)}${where}:`
}

function receivedReply(fileName: string): string {
  return `Received ${fileName}. The Tierra team will confirm shortly.`
}

/** Procurement belongs to the manager; with no manager it falls back to the admin. */
function procurementRoute(accounts: AccountLink[]): Assignment & { assigneeId: string } {
  const route = resolveAssignee(accounts, { assigneeRole: 'manager' })
  if (!route?.assigneeId) throw new Error('No manager or admin account can take procurement')
  return { ...route, assigneeId: route.assigneeId }
}

function holderPhone(route: Assignment): string[] {
  return route.holder?.phoneNumber ? [phoneDigits(route.holder.phoneNumber)] : []
}

function productionPlan(requirement: BananaRequirement, assigneeId: string): ProductionPlan | null {
  if (requirement.bananaKg <= 0) return null
  return {
    finishedGoodsKg: requirement.finishedGoodsKg.toFixed(3),
    kgBananaPerKgChips: requirement.kgBananaPerKgChips.toFixed(3),
    bananaKg: requirement.bananaKg.toFixed(3),
    sourceMonths: requirement.sourceMonths,
    rawItemId: RAW_BANANA_ITEM_ID,
    assigneeId,
  }
}

function raisedBy(accounts: AccountLink[], speaker: Person | null, route: { assigneeId: string }): string {
  return speaker?.userId ?? holderForRole(accounts, 'admin')?.id ?? route.assigneeId
}

async function raiseShortageTask(
  deps: AgentDeps,
  input: { pendingOrderId: string; poNumber: string; shortages: Shortage[]; createdBy: string },
): Promise<void> {
  await createTaskAndNotify(deps, {
    title: `Procure ${input.shortages.map((row) => row.name).join(', ')} for PO ${input.poNumber}`,
    category: 'procurement',
    kind: 'procurement',
    assigneeRole: 'manager',
    description: input.shortages
      .map((row) => `${row.name}: ${procureQuantity(row.requested, row.available)} ${row.unit} short`)
      .join('\n'),
    subjectType: 'pending_order',
    subjectId: input.pendingOrderId,
    createdVia: 'system',
    createdBy: input.createdBy,
  })
}

async function raiseBananaTask(
  deps: AgentDeps,
  input: { orderId: string; poNumber: string; bananaKg: number; createdBy: string },
): Promise<void> {
  await createTaskAndNotify(deps, {
    title: `Procure ${formatKg(input.bananaKg)} kg raw banana for PO ${input.poNumber}`,
    category: 'procurement',
    kind: 'procurement',
    assigneeRole: 'manager',
    subjectType: 'order',
    subjectId: input.orderId,
    createdVia: 'system',
    createdBy: input.createdBy,
  })
}

async function processPdf(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  accounts: AccountLink[],
): Promise<string | null> {
  const pdf = message.pdf
  if (!pdf) return null
  if (await deps.store.hasDocumentForMessage(message.id)) return null
  const hidden = chatKind === 'group' || !speaker
  const inbox = hidden ? adminInbox(accounts) : null
  const adminReport = (text: string) => `${intakeSource(message, chatKind, speaker, pdf.fileName)}\n${text}`
  const report = async (text: string, mentionPhones: string[] = [], subject?: Subject): Promise<string> => {
    if (!hidden) {
      return sendBotText(deps, message, withSender(text, speaker), mentionTargets(message, mentionPhones), subject)
    }
    if (inbox) await tellAdmin(deps, inbox, adminReport(text), subject)
    return sendBotText(deps, message, receivedReply(pdf.fileName))
  }

  let content: Buffer | undefined
  let extracted: ExtractedPo
  try {
    content = await pdfBytes(deps, message)
    extracted = await deps.extractPurchaseOrder(content)
  } catch (error) {
    if (!(error instanceof ExtractError)) throw error
    if (content) {
      await deps.store.insertDocument({
        filename: pdf.fileName,
        mimeType: pdf.mimeType,
        content,
        messageId: message.id,
      })
    }
    return report(error.message)
  }

  const [customers, items, balances, lines, orders] = await Promise.all([
    deps.store.listCustomers(),
    deps.store.listItems(),
    deps.store.listBalances(),
    deps.store.listOrderLines(),
    deps.store.listOrders(),
  ])
  const decision = decideIntake(
    extracted,
    customers,
    items,
    availabilityMap(balances, lines, orders),
    CustomerInventory.from(items, balances, customers),
  )
  if (decision.kind === 'no_inventory') return report(noInventoryReply(decision.customerName))
  if (decision.kind === 'unmatched_lines') return report(lineFailureReply(decision.descriptions))

  const route = procurementRoute(accounts)
  const mentions = hidden ? [] : mentionTargets(message, holderPhone(route))
  const assignedTo = holderLabel(route, mentions[0])
  const createdBy = raisedBy(accounts, speaker, route)

  if (decision.kind === 'short') {
    const confirmer = speaker?.role === 'admin' && !hidden ? null : adminInbox(accounts)
    const documentId = await deps.store.insertDocument({
      filename: pdf.fileName,
      mimeType: pdf.mimeType,
      content,
      messageId: message.id,
    })
    const held = await deps.store.holdShortOrder({
      customerId: decision.customerId,
      poNumber: decision.poNumber,
      poDate: decision.poDate,
      remoteJid: confirmer?.jid ?? replyChatJid(message),
      documentId,
      lines: decision.lines.map((line) => ({
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
      })),
      shortages: decision.shortages.map((row) => ({
        itemId: row.itemId,
        quantity: procureQuantity(row.requested, row.available),
        unit: row.unit,
      })),
      assigneeId: route.assigneeId,
    })
    await raiseShortageTask(deps, {
      pendingOrderId: held.id,
      poNumber: decision.poNumber,
      shortages: decision.shortages,
      createdBy,
    })
    const subject = { subjectType: 'pending_order', subjectId: held.id }
    if (hidden || !confirmer) {
      return report(shortStockReply(decision.poNumber, decision.shortages, assignedTo), mentions, subject)
    }
    await tellAdmin(
      deps,
      confirmer,
      adminReport(shortStockReply(decision.poNumber, decision.shortages, holderLabel(route))),
      subject,
    )
    return report(shortStockReply(decision.poNumber, decision.shortages, assignedTo, confirmer.name), mentions)
  }

  const requirement = bananaRequirement(decision.lines)
  try {
    const created = await deps.store.createOrder({
      customerId: decision.customerId,
      poNumber: decision.poNumber,
      poDate: decision.poDate,
      lines: decision.lines,
      remoteJid: replyChatJid(message),
      document: {
        filename: pdf.fileName,
        mimeType: pdf.mimeType,
        content,
        messageId: message.id,
      },
      production: productionPlan(requirement, route.assigneeId),
    })
    if (created.procurementOrderId) {
      await raiseBananaTask(deps, {
        orderId: created.id,
        poNumber: decision.poNumber,
        bananaKg: requirement.bananaKg,
        createdBy,
      })
    }
    const reply = createdReply({
      orderId: created.id,
      poNumber: decision.poNumber,
      finishedGoodsKg: requirement.finishedGoodsKg,
      bananaKg: requirement.bananaKg,
      procurementOrderId: created.procurementOrderId,
      skipped: requirement.skipped,
      assignedTo,
    })
    return report(reply, created.procurementOrderId ? mentions : [])
  } catch (error) {
    if (!(error instanceof StockShortError)) throw error
    return report(shortReply(decision.poNumber, error.shortages))
  }
}

/** A reply to the order's report, a named PO number, or the only order waiting in this chat. */
async function heldOrderFor(
  store: Store,
  message: IncomingMessage,
  awaiting: PendingConfirmation[],
  poNumber: string | null,
): Promise<PendingConfirmation | null> {
  const quoted = message.quotedId ? await store.findMessage(message.quotedId) : null
  if (quoted?.subjectType === 'pending_order') return awaiting.find((row) => row.id === quoted.subjectId) ?? null
  if (poNumber) return awaiting.find((row) => samePoNumber(row.poNumber, poNumber)) ?? null
  return awaiting.length === 1 ? awaiting[0] : null
}

async function confirmHeldOrder(
  deps: AgentDeps,
  message: IncomingMessage,
  speaker: Person | null,
  accounts: AccountLink[],
  choice: ConfirmationChoice,
): Promise<string | null> {
  const awaiting = await deps.store.listAwaitingConfirmations(replyChatJid(message))
  if (awaiting.length === 0) return null
  if (speaker?.role !== 'admin') {
    return sendBotText(deps, message, withSender(adminOnlyReply(awaiting[0].poNumber), speaker))
  }
  const pending = await heldOrderFor(deps.store, message, awaiting, choice.poNumber)
  if (!pending) return sendBotText(deps, message, whichPoReply(choice.answer))
  if (choice.answer === 'no') {
    const declined = await deps.store.declinePendingOrder(pending.id)
    await deps.store.cancelTasksForSubject('pending_order', pending.id)
    return sendBotText(deps, message, withSender(declinedReply(declined?.poNumber ?? pending.poNumber), speaker))
  }
  const route = procurementRoute(accounts)
  const requirement = bananaRequirement(pending.lines)
  const created = await deps.store.confirmPendingOrder(pending.id, productionPlan(requirement, route.assigneeId))
  if (!created) {
    return sendBotText(deps, message, withSender(declinedReply(pending.poNumber), speaker))
  }
  if (created.procurementOrderId) {
    await raiseBananaTask(deps, {
      orderId: created.id,
      poNumber: created.poNumber,
      bananaKg: requirement.bananaKg,
      createdBy: speaker.userId,
    })
  }
  const mentions = created.procurementOrderId ? mentionTargets(message, holderPhone(route)) : []
  const reply = createdReply({
    orderId: created.id,
    poNumber: created.poNumber,
    finishedGoodsKg: requirement.finishedGoodsKg,
    bananaKg: requirement.bananaKg,
    procurementOrderId: created.procurementOrderId,
    skipped: requirement.skipped,
    assignedTo: holderLabel(route, mentions[0]),
  })
  return sendBotText(deps, message, withSender(reply, speaker), mentions)
}

async function noticeTask(store: Store, messageId: string): Promise<TaskRecord | null> {
  const target = await store.findMessage(messageId)
  if (target?.purpose !== 'task_notice') return null
  return store.findTaskByMessage(messageId)
}

function finishedReply(task: TaskRecord): string {
  return `Marked "${task.title}" as done.`
}

/** A 👍 on a task notice by its holder (or the admin) finishes the task. Nothing else reacts. */
async function handleReaction(deps: AgentDeps, message: IncomingMessage, speaker: Person | null): Promise<string | null> {
  const reaction = message.reaction
  if (!reaction || !speaker || !isDoneEmoji(reaction.emoji)) return null
  const task = await noticeTask(deps.store, reaction.targetId)
  if (!task || !isOpenTask(task) || !canFinish(task, speaker)) return null
  await completeTask(deps, task, speaker)
  return sendBotText(deps, message, finishedReply(task))
}

/**
 * *done* quoting a task notice, or a bare *done* in a DM from someone with one notified open task.
 * Returns undefined when the message is not about finishing a task.
 */
async function handleDoneReply(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!isDoneText(text)) return undefined
  if (message.quotedId) {
    const task = await noticeTask(deps.store, message.quotedId)
    if (!task) return undefined
    if (!speaker || !canFinish(task, speaker)) {
      return sendBotText(deps, message, `Only ${task.assigneeName ?? 'the task holder'} can mark "${task.title}" as done.`)
    }
    if (!isOpenTask(task)) return sendBotText(deps, message, `"${task.title}" is already ${task.status}.`)
    await completeTask(deps, task, speaker)
    return sendBotText(deps, message, finishedReply(task))
  }
  if (chatKind === 'group' || !speaker) return undefined
  const open = (await deps.store.listOpenTasksForUser(speaker.userId)).filter((task) => task.notifiedAt)
  if (open.length === 0) return undefined
  if (open.length > 1) {
    return sendBotText(
      deps,
      message,
      `You have ${open.length} open tasks. Reply *done* to the task's own message so I know which one is finished.`,
    )
  }
  const [task] = open
  await completeTask(deps, task, speaker)
  return sendBotText(deps, message, finishedReply(task))
}

async function sendTestPdf(deps: AgentDeps, message: IncomingMessage): Promise<string> {
  const pdf = await renderTestPdf(deps.now())
  const size = `${Math.max(1, Math.round(pdf.length / 1024))} KB`
  const remoteJid = replyChatJid(message)
  if (isDeskThread(remoteJid)) return sendBotText(deps, message, `Test PDF rendered (${size}).`)
  const caption = ensureTierraPrefix(`Test document (${size})`)
  const sent = await deps.evolution.sendMedia({
    number: deliveryAddress(remoteJid),
    mediatype: 'document',
    mimetype: 'application/pdf',
    fileName: 'tierra-test.pdf',
    caption,
    media: pdf.toString('base64'),
  })
  if (sent.messageId) {
    await deps.store.claimMessage({
      evolutionMessageId: sent.messageId,
      remoteJid,
      fromMe: true,
      hasPdf: true,
      body: caption,
      kind: 'document',
      purpose: 'test_pdf',
      status: 'sent',
    })
  }
  return caption
}

async function createTaskFromChat(
  deps: AgentDeps,
  message: IncomingMessage,
  speaker: Person | null,
  accounts: AccountLink[],
  text: string,
  quotedText: string | null,
): Promise<string> {
  const creator = speaker ? accounts.find((account) => account.id === speaker.userId) : undefined
  if (!creator) return sendBotText(deps, message, withSender(NEED_ACCOUNT, speaker))
  let draft: TaskExtraction
  try {
    draft = await deps.extractTask({
      text,
      quotedText,
      accounts: accounts.map((account) => ({ name: account.name, role: account.role })),
    })
  } catch {
    return sendBotText(deps, message, UNDECIDED)
  }
  if (!draft.category) return sendBotText(deps, message, withSender(NEED_CATEGORY, speaker))
  if (!draft.title?.trim()) return sendBotText(deps, message, withSender(NEED_TITLE, speaker))
  if (draft.assigneeUnknown) return sendBotText(deps, message, withSender(UNKNOWN_ASSIGNEE, speaker))
  const { task, assignment } = await createTaskAndNotify(deps, {
    title: draft.title,
    category: draft.category,
    assigneeRole: draft.assigneeRole,
    subjectType: 'wa_message',
    subjectId: message.id,
    createdVia: isDeskThread(message.remoteJid) ? 'desk' : 'whatsapp',
    createdBy: creator.id,
  })
  const mentions = assignment.holder?.id === creator.id ? [] : mentionTargets(message, holderPhone(assignment))
  return sendBotText(deps, message, withSender(taskReply(task, assignment, mentions[0] ?? null), speaker), mentions)
}

export async function handleIncoming(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  desk?: DeskContext,
): Promise<string | null> {
  const [accounts, connection] = await Promise.all([
    deps.store.listAccountLinks(),
    deps.store.getWhatsapp(),
  ])
  const people = resolvePeople(message, chatKind, accounts, connection.phoneNumber)
  const speaker = desk?.speaker ?? people.speaker

  if (message.reaction) return handleReaction(deps, message, speaker)

  if (!isDeskThread(message.remoteJid)) {
    await deps.evolution
      .sendReaction(message.remoteJid, message.id, message.fromMe, READ_EMOJI)
      .catch(() => undefined)
  }

  if (message.pdf) return processPdf(deps, message, chatKind, speaker, accounts)

  const text = message.text?.trim() ?? ''
  const finished = await handleDoneReply(deps, message, chatKind, speaker, text)
  if (finished !== undefined) return finished

  const internal = Boolean(speaker) && chatKind !== 'group'
  if (internal && TEST_PDF.test(text)) return sendTestPdf(deps, message)

  const choice = text ? confirmationChoice(text) : null
  if (choice) {
    const confirmed = await confirmHeldOrder(deps, message, speaker, accounts, choice)
    if (confirmed !== null) return confirmed
  }
  const quotedText = message.quotedText?.trim() || null
  const mustReply = chatKind === 'personal' || chatKind === 'self'
  if (!text && !quotedText) {
    if (mustReply) return sendBotText(deps, message, HERE)
    return null
  }

  let judged: JudgeResult
  try {
    judged = await deps.judgeIntent({
      chatKind,
      text,
      quotedText,
      speaker,
      mentioned: people.mentioned,
    })
  } catch {
    return sendBotText(deps, message, UNDECIDED)
  }

  if (judged.intent === 'unconfigured') {
    return sendBotText(deps, message, UNDECIDED)
  }
  if (judged.intent === 'needs_pdf' && judged.confidence >= INTENT_CONFIDENCE_FLOOR) {
    return sendBotText(deps, message, NEED_PDF)
  }
  if (
    !mustReply &&
    judged.intent === 'ignore' &&
    judged.confidence >= INTENT_CONFIDENCE_FLOOR
  ) {
    return null
  }

  if (judged.intent === 'create_task' && judged.confidence >= INTENT_CONFIDENCE_FLOOR) {
    return createTaskFromChat(deps, message, speaker, accounts, text, quotedText)
  }

  const unsure = judged.confidence < INTENT_CONFIDENCE_FLOOR || judged.intent === 'ignore'
  const wantsDashboard = chatKind === 'self' || judged.intent === 'dashboard_question'
  const snapshot = internal && wantsDashboard ? await dashboardSnapshot(deps.store) : null
  const jids = [message.remoteJid, message.aliasJid].filter((jid): jid is string => Boolean(jid))
  const recent = await deps.store.listRecentMessages(jids, 8)
  const history: ChatTurn[] = recent.flatMap((row) => {
    const turn = row.body?.trim()
    if (!turn) return []
    const speaker: ChatTurn['speaker'] = turn.startsWith(TIERRA_HEADER)
      ? 'tierra'
      : row.fromMe
        ? 'owner'
        : 'contact'
    return [{ speaker, text: turn }]
  })
  const reply = await deps.completeChat({
    text,
    quotedText,
    snapshot,
    history,
    speaker,
    mentioned: people.mentioned,
    unsure,
  })
  return sendBotText(deps, message, reply)
}

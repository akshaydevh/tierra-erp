import type { AccountLink, CustomerPo } from '../db/types'
import { groupReceivedReply, receivedReply } from '../domain/po'
import { holderForRole } from '../domain/routing'
import { isNotImported } from '../queries/meta'
import { createTaskAndNotify } from '../tasks/service'
import type { Person } from '../whatsapp/people'
import { phoneDigits } from '../whatsapp/qr'
import type { ChatKind, IncomingMessage } from '../whatsapp/parse'
import { describePoSource, intakePo, recordForReview, type IntakeOutcome, type PoSource } from '../workflows/po-intake'
import { adminSummary } from '../workflows/po-text'
import type { AgentDeps } from './deps'
import { ExtractError } from './extract'
import { knownGroup, raiseMapGroupTask } from './groups'
import { deskThreadJid, isDeskThread, postToDesk, sendBotText, type Subject } from './outbox'
import { ensureTierraPrefix, sendDm } from './send'

/**
 * The PDF intake hook (plan §P3). A PDF is stored once per message, then read:
 * - not a PO (invoice, statement): kept; acknowledged in a direct chat, silent in a group;
 * - a PO in a group from one of Tierra's own people: kept, silent (their PDFs there are Tierra's documents);
 * - unreadable: an office review task; the group hears nothing;
 * - a PO: the customer, lines, repeat and inventory check are worked out and recorded. The admin gets the details
 *   (a DM registered with subject ('customer_po', id)); a customer group or an unknown number only hears
 *   "Received PO <no>. We'll confirm shortly." An unmapped group also raises the office's "map group" task. A PO
 *   from an unknown number in a direct chat is recorded and checked but waits for the office (needs_review);
 * - anything that goes wrong on the way still leaves a PO on record for the office (never a stored PDF alone).
 */
export type IntakeInput = {
  message: IncomingMessage
  chatKind: ChatKind
  speaker: Person | null
  accounts: AccountLink[]
  /** A desk upload is stored before its turn is queued; the turn reads it back instead of downloading. */
  documentId?: string | null
}

const PDF_UNAVAILABLE = 'The PDF could not be downloaded. Send it again.'
const NOT_IMPORTED = 'SAP data is not imported yet, so the customer, items and stock could not be checked.'

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

export function withSender(text: string, speaker: Person | null): string {
  if (!speaker) return text
  return `${text} From ${speaker.name}.`
}

function senderLabel(message: IncomingMessage, chatKind: ChatKind, speaker: Person | null): string {
  if (speaker) return speaker.name
  const jids =
    chatKind === 'group' ? [message.participantAltJid, message.participantJid] : [message.aliasJid, message.remoteJid]
  const phone = jids.find((jid) => jid?.endsWith('@s.whatsapp.net'))
  return phone ? `+${phoneDigits(phone)}` : 'an unknown number'
}

async function storedPdf(
  deps: AgentDeps,
  input: IntakeInput,
): Promise<{ documentId: string; content: Buffer } | { error: string } | null> {
  const { message } = input
  const pdf = message.pdf!
  if (input.documentId) {
    const stored = await deps.store.getDocument(input.documentId)
    return stored ? { documentId: input.documentId, content: stored.content } : { error: PDF_UNAVAILABLE }
  }
  if (await deps.store.hasDocumentForMessage(message.id)) return null
  let content: Buffer
  try {
    content = await pdfBytes(deps, message)
  } catch (error) {
    if (!(error instanceof ExtractError)) throw error
    return { error: error.message }
  }
  const documentId = await deps.store.insertDocument({
    filename: pdf.fileName,
    mimeType: pdf.mimeType,
    content,
    messageId: message.id,
  })
  return { documentId, content }
}

function poSubject(po: CustomerPo): Subject {
  return { subjectType: 'customer_po', subjectId: po.id }
}

/** "Review PO <no>" for the office, once per received PO. */
async function raiseReviewTask(
  deps: AgentDeps,
  po: CustomerPo,
  input: IntakeInput,
  where: string,
): Promise<void> {
  const raisedBy = input.speaker?.userId ?? holderForRole(input.accounts, 'admin')?.id
  if (!raisedBy) return
  await createTaskAndNotify(deps, {
    title: `Review PO ${po.poNo ?? input.message.pdf?.fileName ?? ''}`.trim(),
    category: 'operations',
    kind: 'review',
    assigneeRole: 'office',
    description: `${po.reviewReason ?? 'The PO needs a person to look at it.'} Received ${where}. Open it under Orders → Intake.`,
    subjectType: 'customer_po',
    subjectId: po.id,
    createdVia: 'system',
    createdBy: raisedBy,
  })
}

/** The admin's copy of a PO summary: a registered DM, or the admin's desk thread when no phone is linked. */
export async function notifyAdmin(deps: AgentDeps, accounts: AccountLink[], text: string, subject: Subject): Promise<void> {
  const admin = holderForRole(accounts, 'admin')
  if (!admin) return
  const registry = { purpose: 'po_summary', ...subject }
  try {
    if (admin.phoneNumber) {
      await sendDm(deps, admin.phoneNumber, text, registry)
      return
    }
  } catch (error) {
    console.error('Could not send the PO summary to the admin on WhatsApp', error)
  }
  await postToDesk(deps.store, deskThreadJid(admin.id), ensureTierraPrefix(text), subject)
}

async function reply(deps: AgentDeps, input: IntakeInput, outcome: Pick<IntakeOutcome, 'po' | 'summary'>): Promise<string | null> {
  const { message, chatKind, speaker, accounts } = input
  const subject = poSubject(outcome.po)
  if (speaker && chatKind !== 'group') {
    if (speaker.role !== 'admin') await notifyAdmin(deps, accounts, outcome.summary, subject)
    return sendBotText(deps, message, outcome.summary, [], subject)
  }
  await notifyAdmin(deps, accounts, outcome.summary, subject)
  return sendBotText(deps, message, groupReceivedReply(outcome.po.poNo), [], subject)
}

export async function intakePdf(deps: AgentDeps, input: IntakeInput): Promise<string | null> {
  const { message, chatKind, speaker, accounts } = input
  const pdf = message.pdf
  if (!pdf) return null
  const inGroup = chatKind === 'group'
  const stored = await storedPdf(deps, input)
  if (!stored) return null
  if ('error' in stored) return inGroup ? null : sendBotText(deps, message, withSender(stored.error, speaker))
  if (inGroup && speaker) return null

  const sender = senderLabel(message, chatKind, speaker)
  let group: Awaited<ReturnType<typeof knownGroup>> | null = null
  let where = `from ${sender}`
  const source: PoSource = {
    chatJid: message.remoteJid,
    messageId: message.id,
    sender,
    raisedBy: speaker?.userId ?? null,
    documentId: stored.documentId,
    mappedPartyGroupId: null,
    groupSubject: null,
    unknownSender: !inGroup && !speaker && !isDeskThread(message.remoteJid),
  }
  let read: Awaited<ReturnType<AgentDeps['readPurchaseOrder']>>
  try {
    read = await deps.readPurchaseOrder(stored.content)
    if (read.kind === 'not_po') return inGroup ? null : sendBotText(deps, message, receivedReply(pdf.fileName))
    group = inGroup ? await knownGroup(deps, message.remoteJid) : null
    if (group && !group.partyGroupId) {
      await raiseMapGroupTask(deps, message.remoteJid, speaker, accounts, `A purchase order (${pdf.fileName}) arrived in this group, which is not linked to a customer.`)
    }
    if (group) where = `from ${sender} in group ${group.subject ?? message.remoteJid}`
    source.mappedPartyGroupId = group?.partyGroupId ?? null
    source.groupSubject = group ? (group.subject ?? message.remoteJid) : null
  } catch (error) {
    return intakeFailed(deps, input, error, { po: null, poNumber: null, reader: null }, source, where)
  }

  if (read.kind === 'unreadable') {
    const po = await recordForReview(deps, { po: null, poNumber: read.poNumber, reader: read.reader, reason: read.reason }, source)
    await raiseReviewTask(deps, po, input, where)
    if (inGroup) return null
    return sendBotText(
      deps,
      message,
      `Received ${pdf.fileName}. It could not be read automatically: ${read.reason} The office will review it.`,
      [],
      poSubject(po),
    )
  }

  let outcome: Pick<IntakeOutcome, 'po' | 'summary'>
  try {
    outcome = await intakePo(deps, read, source)
  } catch (error) {
    if (!isNotImported(error)) return intakeFailed(deps, input, error, { po: read.po, poNumber: read.po.poNumber, reader: read.reader }, source, where)
    const po = await recordForReview(deps, { po: read.po, poNumber: read.po.poNumber, reader: read.reader, reason: NOT_IMPORTED }, source)
    outcome = { po, summary: `PO ${po.poNo} (${read.po.buyerName ?? 'customer'}) received. ${NOT_IMPORTED} The office has a review task.` }
  }
  if (outcome.po.status === 'needs_review') await raiseReviewTask(deps, outcome.po, input, where)
  return reply(deps, input, outcome)
}

/**
 * Something unexpected broke while reading or checking a PO (C4). The PDF is already stored, so the PO is never lost:
 * the row intake made (if it got that far) goes to needs_review, or a review row is recorded with what was read, and
 * the office gets a review task with the error. Rethrows only when even that cannot be saved.
 */
async function intakeFailed(
  deps: AgentDeps,
  input: IntakeInput,
  error: unknown,
  read: { po: Parameters<typeof recordForReview>[1]['po']; poNumber: string | null; reader: Parameters<typeof recordForReview>[1]['reader'] },
  source: PoSource,
  where: string,
): Promise<string | null> {
  console.error(`PO intake of message ${input.message.id} failed; recording it for review`, error)
  const why = error instanceof Error ? error.message : String(error)
  const reason = `The PO could not be processed automatically (${why.slice(0, 200)}). Check it by hand.`
  const existing = await deps.store.findCustomerPoByMessage(input.message.id)
  const po = existing
    ? ((await deps.store.updateCustomerPo(existing.id, { status: 'needs_review', reviewReason: reason })) ?? existing)
    : await recordForReview(deps, { ...read, reason }, source)
  await raiseReviewTask(deps, po, input, where)
  const summary = adminSummary({ po, check: null, partyLabel: po.partyName, cardName: null, next: null, source: await describePoSource(deps, po).catch(() => null) })
  return reply(deps, input, { po, summary })
}

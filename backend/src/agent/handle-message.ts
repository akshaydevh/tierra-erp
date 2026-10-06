import { randomUUID } from 'node:crypto'
import { bananaRequirement } from '../domain/banana'
import { adminOnlyReply, confirmationChoice, declinedReply } from '../domain/confirm'
import { availabilityMap, dashboardSnapshot } from '../domain/reads'
import {
  createdReply,
  decideIntake,
  lineFailureReply,
  noInventoryReply,
  procureQuantity,
  shortReply,
  shortStockReply,
  type ExtractedPo,
} from '../domain/intake'
import { PROCUREMENT_ASSIGNEE_ID, RAW_BANANA_ITEM_ID } from '../db/seed-data'
import { DESK_THREAD_PREFIX } from '../db/types'
import { CustomerInventory, StockShortError } from '../domain/inventory'
import type { Store } from '../db/store'
import { ExtractError } from './extract'
import type { JudgeInput, JudgeResult } from './judge'
import type { ChatInput, ChatTurn } from './reply'
import type { EvolutionClient } from '../whatsapp/evolution'
import { resolvePeople, type Person } from '../whatsapp/people'
import { phoneDigits } from '../whatsapp/qr'
import { deliveryAddress, replyChatJid, type ChatKind, type IncomingMessage } from '../whatsapp/parse'

export type AgentDeps = {
  store: Store
  evolution: EvolutionClient
  extractPurchaseOrder: (pdf: Buffer) => Promise<ExtractedPo>
  judgeIntent: (input: JudgeInput) => Promise<JudgeResult>
  completeChat: (input: ChatInput) => Promise<string>
}

const PDF_UNAVAILABLE = 'The PDF could not be downloaded. No order was created.'
const READ_EMOJI = '👀'
const INTENT_CONFIDENCE_FLOOR = 0.5
const UNDECIDED = 'Tierra Bot cannot decide yet.'
const NEED_PDF = 'Send the purchase-order PDF and Tierra Bot will read it.'
const HERE = 'Tierra Bot is here.'
const TIERRA_HEADER = '> 🧞‍♂️ Tierra Bot:'

export type DeskContext = {
  speaker: Person
}

export function deskThreadJid(userId: string): string {
  return `${DESK_THREAD_PREFIX}${userId}`
}

export function isDeskThread(remoteJid: string): boolean {
  return remoteJid.startsWith(DESK_THREAD_PREFIX)
}

export function isTierraReply(text: string): boolean {
  return text.trim().startsWith(TIERRA_HEADER)
}

export function tierraReplyText(text: string): string {
  return text
    .replace(/^> 🧞‍♂️ Tierra Bot:\s*/u, '')
    .replace(/^🧞‍♂️ Tierra Bot:\s*/u, '')
    .replace(/^Tierra Bot:\s*/i, '')
    .trim()
}

export function ensureTierraPrefix(text: string): string {
  const trimmed = text.trim()
  if (trimmed.startsWith(TIERRA_HEADER)) return trimmed
  const body = trimmed
    .replace(/^> 🧞‍♂️ Tierra Bot:\s*/u, '')
    .replace(/^🧞‍♂️ Tierra Bot:\s*/u, '')
    .replace(/^Tierra Bot:\s*/i, '')
  return `${TIERRA_HEADER}\n\n${body}`
}

function mentionTargets(message: IncomingMessage, phones: string[]): string[] {
  return isDeskThread(replyChatJid(message)) ? [] : phones
}

async function sendBotText(
  deps: AgentDeps,
  message: IncomingMessage,
  text: string,
  mentionPhones: string[] = [],
): Promise<string> {
  const remoteJid = replyChatJid(message)
  const body = ensureTierraPrefix(text)
  if (isDeskThread(remoteJid)) {
    await deps.store.claimMessage({
      evolutionMessageId: `desk-out-${randomUUID()}`,
      remoteJid,
      fromMe: true,
      hasPdf: false,
      body,
    })
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
  })
  return body
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

export async function processPersonalPdf(
  deps: AgentDeps,
  message: IncomingMessage,
  speaker: Person | null,
): Promise<string | null> {
  if (!message.pdf) return null
  let content: Buffer | undefined
  let extracted: ExtractedPo
  try {
    content = await pdfBytes(deps, message)
    extracted = await deps.extractPurchaseOrder(content)
  } catch (error) {
    if (!(error instanceof ExtractError)) throw error
    if (content) {
      await deps.store.insertDocument({
        filename: message.pdf.fileName,
        mimeType: message.pdf.mimeType,
        content,
        messageId: message.id,
      })
    }
    return sendBotText(deps, message, withSender(error.message, speaker))
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
  if (decision.kind === 'no_inventory') {
    return sendBotText(deps, message, withSender(noInventoryReply(decision.customerName), speaker))
  }
  if (decision.kind === 'unmatched_lines') {
    return sendBotText(deps, message, withSender(lineFailureReply(decision.descriptions), speaker))
  }
  if (decision.kind === 'short') {
    if (!message.pdf) return null
    const documentId = await deps.store.insertDocument({
      filename: message.pdf.fileName,
      mimeType: message.pdf.mimeType,
      content,
      messageId: message.id,
    })
    await deps.store.holdShortOrder({
      customerId: decision.customerId,
      poNumber: decision.poNumber,
      poDate: decision.poDate,
      remoteJid: replyChatJid(message),
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
      assigneeId: PROCUREMENT_ASSIGNEE_ID,
    })
    const accounts = await deps.store.listAccountLinks()
    const joshy = accounts.find((account) => account.id === PROCUREMENT_ASSIGNEE_ID)
    const mentionPhones = mentionTargets(message, joshy?.phoneNumber ? [phoneDigits(joshy.phoneNumber)] : [])
    const reply = shortStockReply(decision.poNumber, decision.shortages)
    const mentioned = mentionPhones.length > 0 ? reply.replace('Joshy', `Joshy @${mentionPhones[0]}`) : reply
    return sendBotText(deps, message, withSender(mentioned, speaker), mentionPhones)
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
        filename: message.pdf.fileName,
        mimeType: message.pdf.mimeType,
        content,
        messageId: message.id,
      },
      production:
        requirement.bananaKg > 0
          ? {
              finishedGoodsKg: requirement.finishedGoodsKg.toFixed(3),
              kgBananaPerKgChips: requirement.kgBananaPerKgChips.toFixed(3),
              bananaKg: requirement.bananaKg.toFixed(3),
              sourceMonths: requirement.sourceMonths,
              rawItemId: RAW_BANANA_ITEM_ID,
              assigneeId: PROCUREMENT_ASSIGNEE_ID,
            }
          : null,
    })
    const accounts = await deps.store.listAccountLinks()
    const joshy = accounts.find((account) => account.id === PROCUREMENT_ASSIGNEE_ID)
    const mentionPhones = mentionTargets(message, joshy?.phoneNumber ? [phoneDigits(joshy.phoneNumber)] : [])
    const reply = createdReply({
      orderId: created.id,
      poNumber: decision.poNumber,
      finishedGoodsKg: requirement.finishedGoodsKg,
      bananaKg: requirement.bananaKg,
      procurementOrderId: created.procurementOrderId,
      skipped: requirement.skipped,
    })
    const mentioned =
      mentionPhones.length > 0 && created.procurementOrderId
        ? reply.replace('Joshy', `Joshy @${mentionPhones[0]}`)
        : reply
    return sendBotText(deps, message, withSender(mentioned, speaker), mentionPhones)
  } catch (error) {
    if (!(error instanceof StockShortError)) throw error
    return sendBotText(deps, message, withSender(shortReply(decision.poNumber, error.shortages), speaker))
  }
}

export async function handleIncoming(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  desk?: DeskContext,
): Promise<string | null> {
  if (!isDeskThread(message.remoteJid)) {
    await deps.evolution
      .sendReaction(message.remoteJid, message.id, message.fromMe, READ_EMOJI)
      .catch(() => undefined)
  }

  const [accounts, connection] = await Promise.all([
    deps.store.listAccountLinks(),
    deps.store.getWhatsapp(),
  ])
  const people = resolvePeople(message, chatKind, accounts, connection.phoneNumber)
  const speaker = desk?.speaker ?? people.speaker

  if (message.pdf) {
    return processPersonalPdf(deps, message, speaker)
  }

  const text = message.text?.trim() ?? ''
  const choice = text ? confirmationChoice(text) : null
  if (choice) {
    const pending = await deps.store.findAwaitingConfirmation(replyChatJid(message))
    if (pending) {
      if (speaker?.role !== 'admin') {
        return sendBotText(deps, message, withSender(adminOnlyReply(pending.poNumber), speaker))
      }
      if (choice === 'no') {
        const declined = await deps.store.declinePendingOrder(pending.id)
        return sendBotText(deps, message, withSender(declinedReply(declined?.poNumber ?? pending.poNumber), speaker))
      }
      const requirement = bananaRequirement(pending.lines)
      const created = await deps.store.confirmPendingOrder(
        pending.id,
        requirement.bananaKg > 0
          ? {
              finishedGoodsKg: requirement.finishedGoodsKg.toFixed(3),
              kgBananaPerKgChips: requirement.kgBananaPerKgChips.toFixed(3),
              bananaKg: requirement.bananaKg.toFixed(3),
              sourceMonths: requirement.sourceMonths,
              rawItemId: RAW_BANANA_ITEM_ID,
              assigneeId: PROCUREMENT_ASSIGNEE_ID,
            }
          : null,
      )
      if (!created) {
        return sendBotText(deps, message, withSender(declinedReply(pending.poNumber), speaker))
      }
      const linked = await deps.store.listAccountLinks()
      const joshy = linked.find((account) => account.id === PROCUREMENT_ASSIGNEE_ID)
      const mentionPhones = mentionTargets(message, joshy?.phoneNumber ? [phoneDigits(joshy.phoneNumber)] : [])
      const reply = createdReply({
        orderId: created.id,
        poNumber: created.poNumber,
        finishedGoodsKg: requirement.finishedGoodsKg,
        bananaKg: requirement.bananaKg,
        procurementOrderId: created.procurementOrderId,
        skipped: requirement.skipped,
      })
      const mentioned =
        mentionPhones.length > 0 && created.procurementOrderId
          ? reply.replace('Joshy', `Joshy @${mentionPhones[0]}`)
          : reply
      return sendBotText(deps, message, withSender(mentioned, speaker), mentionPhones)
    }
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

  const unsure = judged.confidence < INTENT_CONFIDENCE_FLOOR || judged.intent === 'ignore'
  const ownerDesk = chatKind === 'self' || chatKind === 'group'
  const snapshot =
    ownerDesk || judged.intent === 'dashboard_question' ? await dashboardSnapshot(deps.store) : null
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

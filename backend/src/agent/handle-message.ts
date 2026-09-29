import { availabilityMap, dashboardSnapshot } from '../domain/reads'
import {
  createdReply,
  customerFailureReply,
  decideIntake,
  lineFailureReply,
  shortReply,
  type ExtractedPo,
} from '../domain/intake'
import { StockShortError } from '../domain/inventory'
import type { Store } from '../db/store'
import { ExtractError } from './extract'
import type { JudgeInput, JudgeResult } from './judge'
import type { ChatInput } from './reply'
import type { EvolutionClient } from '../whatsapp/evolution'
import { deliveryAddress, type ChatKind, type IncomingMessage } from '../whatsapp/parse'

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
const UNSURE =
  'Tierra Bot is not sure what you want. Ask about orders or stock, or send a purchase-order PDF.'
const UNDECIDED = 'Tierra Bot cannot decide yet.'
const NEED_PDF = 'Send the purchase-order PDF and Tierra Bot will read it.'

function asBot(text: string): string {
  return /tierra bot/i.test(text) ? text : `Tierra Bot: ${text}`
}

async function sendBotText(deps: AgentDeps, remoteJid: string, text: string): Promise<void> {
  const body = asBot(text)
  const sent = await deps.evolution.sendText(deliveryAddress(remoteJid), body)
  if (!sent.messageId) return
  await deps.store.claimMessage({
    evolutionMessageId: sent.messageId,
    remoteJid,
    fromMe: true,
    hasPdf: false,
    body,
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

export async function processPersonalPdf(deps: AgentDeps, message: IncomingMessage): Promise<void> {
  if (!message.pdf) return
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
    await sendBotText(deps, message.remoteJid, error.message)
    return
  }

  const [customers, items, balances, lines, orders] = await Promise.all([
    deps.store.listCustomers(),
    deps.store.listItems(),
    deps.store.listBalances(),
    deps.store.listOrderLines(),
    deps.store.listOrders(),
  ])
  const decision = decideIntake(extracted, customers, items, availabilityMap(balances, lines, orders))
  if (decision.kind === 'unmatched_customer') {
    await sendBotText(deps, message.remoteJid, customerFailureReply(decision.customerName))
    return
  }
  if (decision.kind === 'unmatched_lines') {
    await sendBotText(deps, message.remoteJid, lineFailureReply(decision.descriptions))
    return
  }
  if (decision.kind === 'short') {
    await sendBotText(deps, message.remoteJid, shortReply(decision.poNumber, decision.shortages))
    return
  }

  try {
    const created = await deps.store.createOrder({
      customerId: decision.customerId,
      poNumber: decision.poNumber,
      poDate: decision.poDate,
      lines: decision.lines,
      document: {
        filename: message.pdf.fileName,
        mimeType: message.pdf.mimeType,
        content,
        messageId: message.id,
      },
    })
    await sendBotText(deps, message.remoteJid, createdReply(created.id, decision.poNumber))
  } catch (error) {
    if (!(error instanceof StockShortError)) throw error
    await sendBotText(deps, message.remoteJid, shortReply(decision.poNumber, error.shortages))
  }
}

export async function handleIncoming(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
): Promise<void> {
  await deps.evolution
    .sendReaction(message.remoteJid, message.id, message.fromMe, READ_EMOJI)
    .catch(() => undefined)

  if (message.pdf) {
    await processPersonalPdf(deps, message)
    return
  }

  const text = message.text?.trim() ?? ''
  const quotedText = message.quotedText?.trim() || null
  if (!text && !quotedText) return

  let judged: JudgeResult
  try {
    judged = await deps.judgeIntent({ chatKind, text, quotedText })
  } catch {
    await sendBotText(deps, message.remoteJid, UNDECIDED)
    return
  }

  if (judged.intent === 'unconfigured') {
    await sendBotText(deps, message.remoteJid, UNDECIDED)
    return
  }
  if (judged.confidence < INTENT_CONFIDENCE_FLOOR) {
    await sendBotText(deps, message.remoteJid, UNSURE)
    return
  }
  if (judged.intent === 'ignore') return
  if (judged.intent === 'needs_pdf') {
    await sendBotText(deps, message.remoteJid, NEED_PDF)
    return
  }

  const includeSnapshot =
    judged.intent === 'dashboard_question' && (chatKind === 'self' || chatKind === 'group')
  const snapshot = includeSnapshot ? await dashboardSnapshot(deps.store) : null
  const reply = await deps.completeChat({ text, quotedText, snapshot })
  await sendBotText(deps, message.remoteJid, reply)
}

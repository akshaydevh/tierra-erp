import { availabilityMap } from '../domain/reads'
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
import type { EvolutionClient } from '../whatsapp/evolution'
import { replyNumber, type IncomingMessage } from '../whatsapp/parse'

export type AgentDeps = {
  store: Store
  evolution: EvolutionClient
  extractPurchaseOrder: (pdf: Buffer) => Promise<ExtractedPo>
}

const PDF_UNAVAILABLE = 'The PDF could not be downloaded. No order was created.'

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
  const number = replyNumber(message.remoteJid)
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
    await deps.evolution.sendText(number, error.message)
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
    await deps.evolution.sendText(number, customerFailureReply(decision.customerName))
    return
  }
  if (decision.kind === 'unmatched_lines') {
    await deps.evolution.sendText(number, lineFailureReply(decision.descriptions))
    return
  }
  if (decision.kind === 'short') {
    await deps.evolution.sendText(number, shortReply(decision.poNumber, decision.shortages))
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
    await deps.evolution.sendText(number, createdReply(created.id, decision.poNumber))
  } catch (error) {
    if (!(error instanceof StockShortError)) throw error
    await deps.evolution.sendText(number, shortReply(decision.poNumber, error.shortages))
  }
}
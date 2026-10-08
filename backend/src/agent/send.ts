import type { Store } from '../db/store'
import type { EvolutionClient } from '../whatsapp/evolution'
import { TIERRA_HEADER, isBotEcho } from '../whatsapp/brand'
import { phoneDigits } from '../whatsapp/qr'

export { TIERRA_HEADER }

export function isTierraReply(text: string): boolean {
  return isBotEcho(text)
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
  return `${TIERRA_HEADER}\n\n${tierraReplyText(trimmed)}`
}

export function phoneJid(phone: string): string {
  return `${phoneDigits(phone)}@s.whatsapp.net`
}

export type Registry = {
  purpose: string
  subjectType?: string | null
  subjectId?: string | null
}

/** Sends a bot DM to a phone and registers it. Returns the WhatsApp message id. */
export async function sendDm(
  deps: { store: Store; evolution: EvolutionClient },
  phone: string,
  text: string,
  registry: Registry,
): Promise<string | null> {
  const body = ensureTierraPrefix(text)
  const sent = await deps.evolution.sendText(phoneDigits(phone), body)
  if (sent.messageId) {
    await deps.store.claimMessage({
      evolutionMessageId: sent.messageId,
      remoteJid: phoneJid(phone),
      fromMe: true,
      hasPdf: false,
      body,
      kind: 'text',
      status: 'sent',
      ...registry,
    })
  }
  return sent.messageId
}

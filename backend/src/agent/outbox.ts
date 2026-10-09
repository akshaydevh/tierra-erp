import { randomUUID } from 'node:crypto'
import { DESK_THREAD_PREFIX } from '../db/types'
import type { Store } from '../db/store'
import { deliveryAddress, replyChatJid, type IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { ensureTierraPrefix } from './send'

/** What a bot message is about, so a reply to it can be traced back. */
export type Subject = { subjectType: string; subjectId: string }

export function deskThreadJid(userId: string): string {
  return `${DESK_THREAD_PREFIX}${userId}`
}

export function isDeskThread(remoteJid: string): boolean {
  return remoteJid.startsWith(DESK_THREAD_PREFIX)
}

/** Registry purpose of the tool loop's answers, so approval rules can tell a Q&A turn from an approval request. */
export const AGENT_REPLY = 'agent_reply'

export async function postToDesk(store: Store, remoteJid: string, body: string, subject?: Subject, purpose = 'reply'): Promise<void> {
  await store.claimMessage({
    evolutionMessageId: `desk-out-${randomUUID()}`,
    remoteJid,
    fromMe: true,
    hasPdf: false,
    body,
    purpose,
    ...subject,
  })
}

/** Replies in the chat the message came from (or on the desk) and registers the reply. Returns the sent body. */
export async function sendBotText(
  deps: AgentDeps,
  message: IncomingMessage,
  text: string,
  mentionPhones: string[] = [],
  subject?: Subject,
  purpose = 'reply',
): Promise<string> {
  const remoteJid = replyChatJid(message)
  const body = ensureTierraPrefix(text)
  if (isDeskThread(remoteJid)) {
    await postToDesk(deps.store, remoteJid, body, subject, purpose)
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
    purpose,
    status: 'sent',
    ...subject,
  })
  return body
}

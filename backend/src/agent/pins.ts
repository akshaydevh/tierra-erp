import type { ChatContext } from '../db/types'
import { replyChatJid, type IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'

/**
 * What a chat is pinned to (chat_context): the subject of a quoted bot message, or the approval request sent there.
 * One person's chat can be stored under its phone jid or its LID, so a pin is read across all of them and the newest
 * fresh one wins.
 */

export const PIN_TTL_MS = 6 * 60 * 60_000

/** Every jid this message's chat goes by: the reply jid (phone), the jid it came on, and its alias (LID or phone). */
export function chatJids(message: Pick<IncomingMessage, 'remoteJid' | 'aliasJid'>): string[] {
  return [...new Set([replyChatJid(message as IncomingMessage), message.remoteJid, message.aliasJid].filter((jid): jid is string => Boolean(jid)))]
}

/** The newest pin of the chat that is still fresh (6 h), across all its jids. */
export async function freshPin(
  deps: Pick<AgentDeps, 'store' | 'now'>,
  message: Pick<IncomingMessage, 'remoteJid' | 'aliasJid'>,
): Promise<ChatContext | null> {
  const pins = await Promise.all(chatJids(message).map((jid) => deps.store.getChatContext(jid)))
  const now = deps.now().getTime()
  return (
    pins
      .filter((pin): pin is ChatContext => pin !== null && now - Date.parse(pin.updatedAt) <= PIN_TTL_MS)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0] ?? null
  )
}

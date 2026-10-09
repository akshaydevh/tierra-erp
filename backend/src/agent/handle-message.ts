import type { ChatKind, IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { routeMessage, type DeskContext } from './route'

export type { AgentDeps } from './deps'
export type { DeskContext } from './route'
export { deskThreadJid, isDeskThread } from './outbox'
export { ensureTierraPrefix, isTierraReply, tierraReplyText } from './send'

/** A WhatsApp or desk turn. The work lives in route.ts; this stays the entry point the worker calls. */
export async function handleIncoming(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  desk?: DeskContext,
): Promise<string | null> {
  return routeMessage(deps, message, chatKind, desk)
}

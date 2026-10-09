import type { Approval } from '../db/types'
import {
  INTENT_PROMPT,
  hasDoubt,
  isApproveEmoji,
  isApproveReply,
  isStop,
  looksLikeQuestion,
  parseIntent,
  sendBackNote,
  unquotedApprove,
} from '../domain/approval-match'
import { financialYear } from '../sap/db'
import type { Person } from '../whatsapp/people'
import type { ChatKind, IncomingMessage } from '../whatsapp/parse'
import {
  approveSalesOrder,
  pendingApprovals,
  sendBackSalesOrder,
  stopGroupSend,
  type Decision,
} from '../workflows/so-approval'
import type { AgentDeps } from './deps'
import { AGENT_REPLY, isDeskThread, sendBotText } from './outbox'
import { chatJids, freshPin } from './pins'

/**
 * Approval turns (plan §P4 approval-match), before the model ever sees the message:
 * - a reaction on an approval message: 👍/✅/👌 from the admin approves a pending, current version; from anyone
 *   else it is refused; on an old version, a decided approval or any other emoji it is ignored;
 * - *stop* within the 60 s window; "send back: <note>";
 * - a quoted approve word, an unquoted "approve [TSO/…]";
 * - other admin text while exactly one approval is pending or pinned: a constrained model call decides approve /
 *   send back / question; its approve counts only when the text itself is approval words (rule 2's lexicon). A
 *   question (or anything doubtful) goes on to the tool loop. Right after a tool-loop answer in this chat the admin is
 *   in a conversation, not answering the approval request, so rule 4 does not run at all.
 * The pin is set when the approval request is sent and when the admin quotes it, never by ordinary messages.
 * Returns undefined when the turn is not about an approval.
 */

const INTENT_TIMEOUT_MS = 15_000

function subjectOf(approval: Approval) {
  return { subjectType: 'approval', subjectId: approval.id }
}

async function docNoOf(deps: AgentDeps, approval: Approval): Promise<string> {
  return (await deps.store.getSalesOrder(approval.subjectId))?.docNo ?? 'that sales order'
}

/** The approval a quoted bot message belongs to: one of its approval messages, or a bot message about it. */
async function quotedApproval(deps: AgentDeps, message: IncomingMessage): Promise<Approval | null> {
  if (!message.quotedId) return null
  const direct = await deps.store.findApprovalByMessage(message.quotedId)
  if (direct) return direct
  const quoted = await deps.store.findMessage(message.quotedId)
  if (!quoted?.fromMe || !quoted.subjectId) return null
  if (quoted.subjectType === 'approval') return deps.store.getApproval(quoted.subjectId)
  if (quoted.subjectType === 'sales_order') {
    const [latest] = await deps.store.listApprovals({ subjectType: 'sales_order', subjectId: quoted.subjectId, limit: 1 })
    return latest ?? null
  }
  return null
}

/** The bot's last message in this chat was a tool-loop answer (the admin is asking questions, not deciding). */
async function lastBotTurnWasAnswer(deps: AgentDeps, message: IncomingMessage): Promise<boolean> {
  const rows = await deps.store.listRecentMessages(chatJids(message), 12)
  const at = rows.findIndex((row) => row.id === message.id)
  const before = at >= 0 ? rows.slice(0, at) : rows
  const lastBot = [...before].reverse().find((row) => row.fromMe && row.purpose)
  return lastBot?.purpose === AGENT_REPLY
}

/** The approval this chat is pinned to (fresh), whatever its status. */
async function pinnedApproval(deps: AgentDeps, message: IncomingMessage): Promise<Approval | null> {
  const pin = await freshPin(deps, message)
  if (pin?.subjectType === 'approval') return deps.store.getApproval(pin.subjectId)
  if (pin?.subjectType === 'sales_order') {
    const [latest] = await deps.store.listApprovals({ subjectType: 'sales_order', subjectId: pin.subjectId, limit: 1 })
    return latest ?? null
  }
  return null
}

async function reply(deps: AgentDeps, message: IncomingMessage, decision: Decision, approval: Approval): Promise<string | null> {
  if (!decision.text) return null
  return sendBotText(deps, message, decision.text, [], subjectOf(decision.ok ? decision.approval : approval))
}

export async function handleApprovalReaction(
  deps: AgentDeps,
  message: IncomingMessage,
  speaker: Person | null,
): Promise<string | null | undefined> {
  const reaction = message.reaction
  if (!reaction) return undefined
  const approval = await deps.store.findApprovalByMessage(reaction.targetId)
  if (!approval) return undefined
  if (!reaction.emoji) {
    console.log(`approval ${approval.id}: a reaction was removed by ${speaker?.name ?? 'someone'}; logged only`)
    return null
  }
  if (!isApproveEmoji(reaction.emoji)) return null
  if (!speaker || speaker.role !== approval.approverRole) {
    console.warn(`approval ${approval.id}: 👍 from ${speaker?.name ?? 'an unknown number'} refused`)
    return speaker ? sendBotText(deps, message, `Only the admin can approve ${await docNoOf(deps, approval)}.`) : null
  }
  if (approval.status !== 'pending') return null
  const decision = await approveSalesOrder(deps, approval, speaker, { via: 'reaction', channel: 'whatsapp' })
  return reply(deps, message, decision, approval)
}

/** Below this TypeSafe confidence an answer is treated as a question. */
const INTENT_CONFIDENCE_FLOOR = 0.6

/** What an unclear admin message means for a pending approval: TypeSafe when configured, else the chat model. Unsure is a question. */
export async function classify(deps: AgentDeps, approval: Approval, text: string): Promise<{ intent: string; note: string | null }> {
  const order = await deps.store.getSalesOrder(approval.subjectId)
  if (deps.approvalIntent) {
    try {
      const answer = await deps.approvalIntent({
        order: `${order?.docNo ?? ''} (${order?.partyName ?? order?.cardCode ?? ''}, ₹${order?.total ?? ''})`,
        text,
      })
      if (answer.confidence < INTENT_CONFIDENCE_FLOOR) return { intent: 'question', note: null }
      return { intent: answer.intent, note: answer.intent === 'send_back' ? (sendBackNote(text) ?? text.trim()) : null }
    } catch (error) {
      // TypeSafe down or slow: treat it as a question, never as an approval
      console.error('approval_intent (TypeSafe) failed', error)
      return { intent: 'question', note: null }
    }
  }
  try {
    const response = await deps.chatModel({
      messages: [
        { role: 'system', content: INTENT_PROMPT },
        {
          role: 'user',
          content: `Sales order ${order?.docNo ?? ''} (${order?.partyName ?? order?.cardCode ?? ''}, ₹${order?.total ?? ''}) is waiting for the admin's approval.\nMessage: ${JSON.stringify(text)}`,
        },
      ],
      tools: [],
      signal: AbortSignal.timeout(INTENT_TIMEOUT_MS),
    })
    return parseIntent(response.content)
  } catch (error) {
    // no model (no key), a timeout or a bad answer: treat it as a question, never as an approval
    if (!(error instanceof Error && error.name === 'LlmUnavailableError')) console.error('approval_intent failed', error)
    return { intent: 'question', note: null }
  }
}

/** Which TSO an unquoted "approve TSO/26-27/0001" (or "approve 1") names among the pending ones. */
async function namedApproval(deps: AgentDeps, pending: Approval[], docNo: string): Promise<Approval | null> {
  const wanted = /^\d+$/.test(docNo) ? `TSO/${financialYear(deps.now().toISOString().slice(0, 10))}/${docNo.padStart(4, '0')}` : docNo
  for (const approval of pending) {
    const order = await deps.store.getSalesOrder(approval.subjectId)
    if (order?.docNo === wanted || (order && /^\d+$/.test(docNo) && order.seq === Number(docNo))) return approval
  }
  return null
}

export async function handleApprovalText(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!speaker || chatKind === 'group' || !text) return undefined
  const admin = speaker.role === 'admin'
  const channel = isDeskThread(message.remoteJid) ? 'desk' : 'whatsapp'
  const quoted = await quotedApproval(deps, message)

  if (isStop(text)) {
    if (!admin) return undefined
    return sendBotText(deps, message, await stopGroupSend(deps, speaker))
  }

  const note = sendBackNote(text)
  if (note !== null) {
    if (!admin) return sendBotText(deps, message, 'Only the admin can send back a sales order.')
    const pending = await pendingApprovals(deps)
    const target = quoted ?? (await pinnedApproval(deps, message)) ?? (pending.length === 1 ? pending[0]! : null)
    if (!target) {
      return sendBotText(
        deps,
        message,
        pending.length ? 'Which sales order? Reply *send back: <note>* to its approval message.' : 'No sales order is waiting for approval.',
      )
    }
    return reply(deps, message, await sendBackSalesOrder(deps, target, speaker, note, { via: quoted ? 'reply' : 'text', channel }), target)
  }

  if (quoted) {
    const approveWords = isApproveReply(text)
    if (approveWords && !admin) return sendBotText(deps, message, `Only the admin can approve ${await docNoOf(deps, quoted)}.`)
    if (approveWords) {
      if (quoted.status !== 'pending') {
        const docNo = await docNoOf(deps, quoted)
        return sendBotText(deps, message, quoted.status === 'approved' ? `${docNo} is already approved.` : `That version of ${docNo} is no longer waiting for approval.`)
      }
      return reply(deps, message, await approveSalesOrder(deps, quoted, speaker, { via: 'reply', channel }), quoted)
    }
  }

  const unquoted = quoted ? null : unquotedApprove(text)
  if (unquoted) {
    if (!admin) return sendBotText(deps, message, 'Only the admin can approve sales orders.')
    const pending = await pendingApprovals(deps)
    const pinned = await pinnedApproval(deps, message)
    const target = unquoted.docNo
      ? await namedApproval(deps, pending, unquoted.docNo)
      : pending.length === 1
        ? pending[0]!
        : (pending.find((approval) => approval.id === pinned?.id) ?? null)
    if (!target) {
      if (!pending.length) return sendBotText(deps, message, 'No sales order is waiting for approval.')
      const numbers = await Promise.all(pending.map((approval) => docNoOf(deps, approval)))
      return sendBotText(
        deps,
        message,
        unquoted.docNo
          ? `${unquoted.docNo} is not waiting for approval. Waiting: ${numbers.join(', ')}.`
          : `${pending.length} sales orders are waiting: ${numbers.join(', ')}. Reply "approve TSO/…" or react 👍 on its message.`,
      )
    }
    return reply(deps, message, await approveSalesOrder(deps, target, speaker, { via: 'text', channel }), target)
  }

  // rule 4: admin text with exactly one approval pending or pinned. A reply to some other bot message, or a chat
  // pinned to something else (a PO, a task), is about that, never an approval; so is the turn right after a tool-loop
  // answer (the admin is talking with the bot). The pin is not refreshed here: only the request and a quote set it.
  if (!admin) return undefined
  if (message.quotedId && !quoted) return undefined
  const pin = quoted ? null : await freshPin(deps, message)
  if (pin && pin.subjectType !== 'approval' && pin.subjectType !== 'sales_order') return undefined
  if (!quoted && (await lastBotTurnWasAnswer(deps, message))) return undefined
  const pending = await pendingApprovals(deps)
  const pinned = quoted ?? (await pinnedApproval(deps, message))
  const candidate = pinned?.status === 'pending' ? pinned : !pinned && pending.length === 1 ? pending[0]! : null
  if (!candidate) return undefined
  if (looksLikeQuestion(text) || hasDoubt(text)) return undefined
  const intent = await classify(deps, candidate, text)
  // the model may only confirm what the words already say: "approve", "ok", "yes go ahead" ...
  if (intent.intent === 'approve' && isApproveReply(text)) {
    return reply(deps, message, await approveSalesOrder(deps, candidate, speaker, { via: 'llm', channel }), candidate)
  }
  if (intent.intent === 'send_back') {
    return reply(deps, message, await sendBackSalesOrder(deps, candidate, speaker, intent.note ?? text, { via: 'llm', channel }), candidate)
  }
  return undefined
}

import type { CustomerPo } from '../db/types'
import { hasDoubt, looksLikeQuestion } from '../domain/approval-match'
import type { Person } from '../whatsapp/people'
import type { ChatKind, IncomingMessage } from '../whatsapp/parse'
import { proceedWithPo } from '../workflows/po-intake'
import { pendingApprovals } from '../workflows/so-approval'
import { lastBotTurnWasAnswer } from './approvals'
import { CONFIDENCE_FLOOR } from './classifiers'
import type { AgentDeps } from './deps'
import { sendBotText } from './outbox'
import { freshPin } from './pins'

/** *proceed*: the admin goes ahead with a PO waiting for it. "yes" or "go ahead" stay SO approval words. */
export const PROCEED = /^proceed\b/i

/** Which PO a *proceed* means: the quoted bot message, a PO number in the text, the chat's pin, or the only one waiting. */
async function targetPo(deps: AgentDeps, message: IncomingMessage, text: string): Promise<CustomerPo | 'ambiguous' | null> {
  if (message.quotedId) {
    const quoted = await deps.store.findMessage(message.quotedId)
    if (quoted?.fromMe && quoted.subjectType === 'customer_po' && quoted.subjectId) {
      return deps.store.getCustomerPo(quoted.subjectId)
    }
  }
  const number = /proceed\s+(?:with\s+)?(?:po\s*)?([A-Z0-9][A-Z0-9/\-]{3,})/i.exec(text)?.[1]
  if (number) {
    const found = (await deps.store.findCustomerPosByNumber(number)).filter((po) => po.status === 'awaiting_proceed')
    if (found.length === 1) return found[0]!
    if (found.length > 1) return 'ambiguous'
  }
  const pin = await freshPin(deps, message)
  if (pin?.subjectType === 'customer_po') {
    const pinned = await deps.store.getCustomerPo(pin.subjectId)
    if (pinned?.status === 'awaiting_proceed') return pinned
  }
  const waiting = await deps.store.listCustomerPos({ status: 'awaiting_proceed', limit: 2 })
  if (waiting.length === 1) return deps.store.getCustomerPo(waiting[0]!.id)
  return waiting.length > 1 ? 'ambiguous' : null
}

export async function handleProceed(deps: AgentDeps, message: IncomingMessage, speaker: Person, text: string): Promise<string> {
  if (speaker.role !== 'admin') return sendBotText(deps, message, 'Only the admin can go ahead with a PO.')
  const po = await targetPo(deps, message, text)
  if (po === 'ambiguous') {
    return sendBotText(deps, message, 'More than one PO is waiting. Reply *proceed* to the PO message, or write "proceed <PO number>".')
  }
  if (!po) return sendBotText(deps, message, 'No PO is waiting for *proceed*.')
  const answer = await proceedWithPo(deps, po.id)
  return sendBotText(deps, message, answer, [], { subjectType: 'customer_po', subjectId: po.id })
}

/** A go-ahead has to be in the admin's own words; TypeSafe may only confirm what they already say. */
const GO_WORDS = /\b(?:yes|yeah|yep|ok|okay|sure|proceed|go ahead|go on|carry on|do it|confirm(?:ed)?|fine|approved?|raise it)\b/i

type ProceedTarget = { po: CustomerPo } | { ambiguous: string } | null

function label(po: CustomerPo): string {
  return `PO ${po.poNo ?? '(no number)'} (${po.partyName ?? po.cardCode ?? 'customer'}, ₹${po.total ?? ''})`
}

/**
 * The PO an unworded reply is about: the quoted PO message, the chat's PO pin, or the only PO waiting when nothing else
 * is (no SO approval pending, no conversation with the bot going on). A quote or pin of anything else is never a PO reply.
 */
async function poInContext(deps: AgentDeps, message: IncomingMessage): Promise<ProceedTarget> {
  if (message.quotedId) {
    const quoted = await deps.store.findMessage(message.quotedId)
    if (!quoted?.fromMe || quoted.subjectType !== 'customer_po' || !quoted.subjectId) return null
    const po = await deps.store.getCustomerPo(quoted.subjectId)
    return po?.status === 'awaiting_proceed' ? { po } : null
  }
  const pin = await freshPin(deps, message)
  if (pin?.subjectType === 'customer_po') {
    const po = await deps.store.getCustomerPo(pin.subjectId)
    return po?.status === 'awaiting_proceed' ? { po } : null
  }
  if (pin) return null
  const waiting = await deps.store.listCustomerPos({ status: 'awaiting_proceed', limit: 2 })
  if (!waiting.length || (await lastBotTurnWasAnswer(deps, message))) return null
  const approvals = await pendingApprovals(deps)
  if (waiting.length > 1 || approvals.length) {
    return { ambiguous: 'More than one thing is waiting for you. Reply to the PO message (*proceed*) or the sales order message you mean.' }
  }
  const po = await deps.store.getCustomerPo(waiting[0]!.id)
  return po ? { po } : null
}

/**
 * The admin's own words about a PO waiting for *proceed* ("yes, raise it", "hold this one"): TypeSafe reads them.
 * Proceeds only when TypeSafe is sure and the words say yes without doubt; anything else goes on to the next handler.
 */
export async function handleProceedText(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!deps.proceedIntent || speaker?.role !== 'admin' || chatKind === 'group' || !text || looksLikeQuestion(text)) return undefined
  const target = await poInContext(deps, message)
  if (!target) return undefined
  const goes = GO_WORDS.test(text) && !hasDoubt(text)
  if ('ambiguous' in target) return goes ? sendBotText(deps, message, target.ambiguous) : undefined
  const { po } = target
  let answer
  try {
    answer = await deps.proceedIntent({ po: label(po), text })
  } catch (error) {
    console.error('proceed_intent (TypeSafe) failed; leaving the PO waiting', error)
    return undefined
  }
  if (answer.confidence < CONFIDENCE_FLOOR) return undefined
  const subject = { subjectType: 'customer_po', subjectId: po.id }
  if (answer.choice === 'proceed' && goes) return sendBotText(deps, message, await proceedWithPo(deps, po.id), [], subject)
  if (answer.choice === 'hold') {
    return sendBotText(deps, message, `OK, ${po.poNo ? `PO ${po.poNo}` : 'that PO'} stays on hold. Reply *proceed* to it when you want to go ahead.`, [], subject)
  }
  return undefined
}

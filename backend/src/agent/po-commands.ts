import type { CustomerPo } from '../db/types'
import type { Person } from '../whatsapp/people'
import type { IncomingMessage } from '../whatsapp/parse'
import { proceedWithPo } from '../workflows/po-intake'
import type { AgentDeps } from './deps'
import { sendBotText } from './outbox'
import { freshPin } from './pins'

/** *proceed*: the admin goes ahead with a repeat PO (one already in SAP or already received). */
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
  if (speaker.role !== 'admin') return sendBotText(deps, message, 'Only the admin can go ahead with a repeat PO.')
  const po = await targetPo(deps, message, text)
  if (po === 'ambiguous') {
    return sendBotText(deps, message, 'More than one repeat PO is waiting. Reply *proceed* to the PO message, or write "proceed <PO number>".')
  }
  if (!po) return sendBotText(deps, message, 'No repeat PO is waiting for *proceed*.')
  const answer = await proceedWithPo(deps, po.id)
  return sendBotText(deps, message, answer, [], { subjectType: 'customer_po', subjectId: po.id })
}

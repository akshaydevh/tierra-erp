import { parseReceipt } from '../domain/receipts'
import type { Person } from '../whatsapp/people'
import type { ChatKind, IncomingMessage } from '../whatsapp/parse'
import { JOB_PO_RECHECK } from '../workflows/po-to-so'
import { recordReceipt } from '../workflows/receipts'
import type { AgentDeps } from './deps'
import { isDeskThread, sendBotText } from './outbox'

/**
 * Deterministic order commands from Tierra's own people (plan §3.4):
 * - "received 20 kg ZPMLMA, 160 kg ZOILP": unposted stock adjustments the next check counts;
 * - "recheck PO 5115299998": checks a PO on hold again now.
 * Returns undefined when the message is neither.
 */
export async function handleOrderCommand(
  deps: AgentDeps,
  message: IncomingMessage,
  chatKind: ChatKind,
  speaker: Person | null,
  text: string,
): Promise<string | null | undefined> {
  if (!speaker || chatKind === 'group') return undefined
  const receipt = parseReceipt(text)
  if (receipt && receipt.length) {
    const via = isDeskThread(message.remoteJid) ? 'desk' : 'whatsapp'
    return sendBotText(deps, message, (await recordReceipt(deps, receipt, speaker, via)).text)
  }
  const recheck = /^re-?check\s+(?:po\s*)?([A-Z0-9][A-Z0-9/\-]{3,})\s*$/i.exec(text.trim())
  if (recheck) {
    const pos = (await deps.store.findCustomerPosByNumber(recheck[1]!)).filter((po) => po.status === 'short')
    if (pos.length !== 1) {
      return sendBotText(deps, message, pos.length ? 'More than one PO with that number is on hold.' : `PO ${recheck[1]} is not on hold for materials.`)
    }
    await deps.enqueue({
      kind: JOB_PO_RECHECK,
      payload: { customerPoId: pos[0]!.id, taskId: null },
      idempotencyKey: `${JOB_PO_RECHECK}:${pos[0]!.id}:${message.id}`,
    })
    return sendBotText(deps, message, `Checking PO ${recheck[1]} again. If it passes, the sales order follows.`)
  }
  return undefined
}

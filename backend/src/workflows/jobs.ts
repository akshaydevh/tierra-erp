import type { AgentDeps } from '../agent/deps'
import { JOB_PO_PROCESS, JOB_PO_RECHECK, JOB_SO_ASK, JOB_SO_GROUP, JOB_SO_RENDER, processPo, recheckPo, renderForApproval, sendForApproval, sendToGroup } from './po-to-so'
import { reviseSalesOrder } from './so-approval'

export const JOB_SO_REVISE = 'so.revise'

/** Runs a PO / sales-order job (plan §3.5); false when the kind is not one of them. */
export async function runOrderJob(deps: AgentDeps, kind: string, payload: Record<string, unknown>): Promise<boolean> {
  const id = (key: string) => (typeof payload[key] === 'string' ? (payload[key] as string) : '')
  if (kind === JOB_PO_PROCESS) await processPo(deps, id('customerPoId'), id('checkId') || null)
  else if (kind === JOB_PO_RECHECK) await recheckPo(deps, id('customerPoId'), id('taskId') || null)
  else if (kind === JOB_SO_RENDER) await renderForApproval(deps, id('salesOrderId'), Number(payload.version ?? 1))
  else if (kind === JOB_SO_ASK) await sendForApproval(deps, id('approvalId'))
  else if (kind === JOB_SO_GROUP) await sendToGroup(deps, id('approvalId'))
  else if (kind === JOB_SO_REVISE) await reviseSalesOrder(deps, id('salesOrderId'), Number(payload.fromVersion ?? 1))
  else return false
  return true
}

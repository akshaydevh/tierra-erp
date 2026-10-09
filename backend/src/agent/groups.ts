import type { AccountLink, WaGroup } from '../db/types'
import { holderForRole } from '../domain/routing'
import { createTaskAndNotify } from '../tasks/service'
import type { Person } from '../whatsapp/people'
import type { AgentDeps } from './deps'

/** The group's row, with its WhatsApp subject filled in from Evolution when it is not known yet. */
export async function knownGroup(deps: AgentDeps, jid: string): Promise<WaGroup> {
  const group = await deps.store.getWaGroup(jid)
  if (group?.subject) return group
  const subject = (await deps.evolution.fetchAllGroups().catch(() => [])).find((row) => row.id === jid)?.subject ?? null
  return deps.store.saveWaGroup(jid, subject ? { subject } : {})
}

/**
 * An office task "Map WhatsApp group <subject>", once per group (subject ('wa_group', jid)): the bot was asked
 * something, or sent a PO, in a group that is not linked to a customer yet.
 */
export async function raiseMapGroupTask(
  deps: AgentDeps,
  jid: string,
  speaker: Person | null,
  accounts: AccountLink[],
  why = 'Tierra Bot was asked something in this group, but it is not linked to a customer.',
): Promise<WaGroup> {
  const group = await knownGroup(deps, jid)
  const raisedBy = speaker?.userId ?? holderForRole(accounts, 'admin')?.id
  if (raisedBy) {
    await createTaskAndNotify(deps, {
      title: `Map WhatsApp group ${group.subject ?? jid}`,
      category: 'administration',
      assigneeRole: 'office',
      description: `${why} Link it to a party group in Settings so the bot can answer there. Group id ${jid}.`,
      subjectType: 'wa_group',
      subjectId: jid,
      createdVia: 'system',
      createdBy: raisedBy,
    })
  }
  return group
}

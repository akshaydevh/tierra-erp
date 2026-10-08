import { roleLabel, type AccountLink, type Role } from '../db/types'

export type Assignment = {
  assigneeId: string | null
  assigneeRole: Role | null
  holder: AccountLink | null
  /** The role had no holder, so the task went to the admin instead. */
  unrouted: boolean
}

/** The account holding a role, preferring one with a linked phone. */
export function holderForRole(accounts: AccountLink[], role: Role): AccountLink | null {
  const holders = accounts
    .filter((account) => account.role === role)
    .sort(
      (a, b) =>
        Number(Boolean(b.phoneNumber)) - Number(Boolean(a.phoneNumber)) || a.id.localeCompare(b.id),
    )
  return holders[0] ?? null
}

/**
 * Picks who does a task. A named person wins; a role resolves to its holder, or to the
 * admin when nobody holds it. Returns null when the named person is not an account.
 */
export function resolveAssignee(
  accounts: AccountLink[],
  input: { assigneeId?: string | null; assigneeRole?: Role | null },
): Assignment | null {
  const assigneeRole = input.assigneeRole ?? null
  if (input.assigneeId) {
    const holder = accounts.find((account) => account.id === input.assigneeId)
    if (!holder) return null
    return { assigneeId: holder.id, assigneeRole, holder, unrouted: false }
  }
  if (!assigneeRole) return { assigneeId: null, assigneeRole: null, holder: null, unrouted: false }
  const holder = holderForRole(accounts, assigneeRole)
  if (holder) return { assigneeId: holder.id, assigneeRole, holder, unrouted: false }
  const admin = holderForRole(accounts, 'admin')
  return { assigneeId: admin?.id ?? null, assigneeRole, holder: admin, unrouted: true }
}

/** "the manager (<name>)", with an @mention when a phone is given. */
export function holderLabel(assignment: Assignment, mentionPhone?: string | null): string {
  const role = assignment.unrouted ? 'admin' : assignment.assigneeRole
  const name = assignment.holder
    ? `${assignment.holder.name}${mentionPhone ? ` @${mentionPhone}` : ''}`
    : null
  if (!role) return name ?? 'nobody'
  const label = `the ${roleLabel(role).toLowerCase()}`
  const who = name ? `${label} (${name})` : label
  if (assignment.unrouted && assignment.assigneeRole) {
    return `${who}, as no ${roleLabel(assignment.assigneeRole).toLowerCase()} is set up`
  }
  return who
}

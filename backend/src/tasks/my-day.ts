import type { PublicUser, TaskRecord } from '../db/types'

/**
 * My Day (frontend.md §My Day, plan §P4): three zones, no drag columns.
 * - Open · your move: open tasks the person holds, and open tasks addressed to their role, by due time.
 * - Waiting on others: open tasks they raised that someone else holds (never one already in "your move": a task
 *   addressed to their own role is theirs to do, not something they wait on).
 * - Closed today: tasks of theirs (held or of their role) finished today, India time.
 */

export type MyDay = {
  open: TaskRecord[]
  waiting: TaskRecord[]
  closedToday: TaskRecord[]
}

function istDay(iso: string | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso))
}

function byDue(a: TaskRecord, b: TaskRecord): number {
  if (a.dueAt && b.dueAt) return a.dueAt.localeCompare(b.dueAt)
  if (a.dueAt) return -1
  if (b.dueAt) return 1
  return b.createdAt.localeCompare(a.createdAt)
}

export function myDay(tasks: TaskRecord[], user: Pick<PublicUser, 'id' | 'role'>, now: Date): MyDay {
  const open = (task: TaskRecord) => task.status === 'todo' || task.status === 'doing'
  const mine = (task: TaskRecord) => task.assigneeId === user.id || task.assigneeRole === user.role
  const today = istDay(now)
  return {
    open: tasks.filter((task) => open(task) && mine(task)).sort(byDue),
    waiting: tasks
      .filter((task) => open(task) && !mine(task) && task.createdBy === user.id && task.createdVia !== 'system')
      .sort(byDue),
    closedToday: tasks
      .filter((task) => task.status === 'done' && task.completedAt && istDay(task.completedAt) === today && mine(task))
      .sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')),
  }
}

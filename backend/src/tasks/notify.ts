import type { AgentDeps } from '../agent/handle-message'
import { sendDm } from '../agent/send'
import type { TaskRecord } from '../db/types'

const IST = 'Asia/Kolkata'

function istDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(date)
}

function istTime(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
}

function istDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: IST, day: 'numeric', month: 'short' }).format(date)
}

export function dueLabel(dueAt: string, now: Date): string {
  const due = new Date(dueAt)
  if (istDay(due) === istDay(now)) return `due ${istTime(due)}`
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)
  if (istDay(due) === istDay(tomorrow)) return `due tomorrow ${istTime(due)}`
  return `due ${istDate(due)} ${istTime(due)}`
}

export function taskNoticeText(task: TaskRecord, raiserName: string, now: Date): string {
  const heading = [`New task from ${raiserName}`, task.dueAt ? dueLabel(task.dueAt, now) : null]
    .filter(Boolean)
    .join(' · ')
  return [
    heading,
    `*${task.title}*`,
    task.description?.trim() || null,
    'Reply *done* to this message or react 👍 when it is finished.',
  ]
    .filter((line): line is string => Boolean(line))
    .join('\n')
}

function raiserName(task: TaskRecord): string {
  if (task.createdVia === 'system') return 'Tierra Bot'
  return task.createdByName ?? 'Tierra'
}

export function needsNotice(task: TaskRecord): boolean {
  return task.kind !== 'approval' && Boolean(task.assigneeId) && (task.status === 'todo' || task.status === 'doing')
}

/** With the worker's 5-minute backoff cap, 30 attempts keep a notice alive for about two hours. */
const NOTICE_ATTEMPTS = 30

/**
 * Queues the notice for the task's current holder. The key names the holder and when they got the
 * task, so a reassignment (even back to an earlier holder) is a new notice and a repeat is not.
 */
export async function queueTaskNotice(deps: AgentDeps, task: TaskRecord, retry?: Date): Promise<void> {
  if (!needsNotice(task)) return
  const key = `task.notify:${task.id}:${task.assigneeId}:${Date.parse(task.assignedAt)}`
  await deps.enqueue({
    kind: 'task.notify',
    payload: { taskId: task.id, assigneeId: task.assigneeId },
    idempotencyKey: retry ? `${key}:retry:${retry.getTime()}` : key,
    maxAttempts: NOTICE_ATTEMPTS,
  })
}

const STALE_RESERVATION_MS = 10 * 60_000

/**
 * At boot and after WhatsApp reconnects: queue again every notice that never went out to a
 * holder with a phone, including ones whose sender died between reserving and sending.
 */
export async function requeueTaskNotices(deps: AgentDeps): Promise<void> {
  await deps.store.releaseStaleTaskNotices(new Date(deps.now().getTime() - STALE_RESERVATION_MS))
  const [tasks, accounts] = await Promise.all([deps.store.listUnnotifiedOpenTasks(), deps.store.listAccountLinks()])
  const reachable = new Set(accounts.filter((account) => account.phoneNumber).map((account) => account.id))
  const now = deps.now()
  for (const task of tasks) {
    if (task.assigneeId && reachable.has(task.assigneeId)) await queueTaskNotice(deps, task, now)
  }
}

/** Job handler: DMs the holder and remembers the notice so *done* or 👍 on it finishes the task. */
export async function sendTaskNotice(deps: AgentDeps, taskId: string, assigneeId?: string): Promise<void> {
  const task = await deps.store.getTask(taskId)
  if (!task || !needsNotice(task) || task.notifiedAt) return
  if (assigneeId && task.assigneeId !== assigneeId) return
  const holder = (await deps.store.listAccountLinks()).find((account) => account.id === task.assigneeId)
  if (!holder?.phoneNumber) {
    console.warn(`Task ${task.id} was not sent: ${holder?.name ?? 'the holder'} has no linked phone`)
    return
  }
  if (!(await deps.store.reserveTaskNotice(task.id, holder.id))) return
  const now = deps.now()
  let messageId: string | null
  try {
    messageId = await sendDm(deps, holder.phoneNumber, taskNoticeText(task, raiserName(task), now), {
      purpose: 'task_notice',
      subjectType: 'task',
      subjectId: task.id,
    })
  } catch (error) {
    await deps.store.releaseTaskNotice(task.id)
    throw error
  }
  await deps.store.markTaskNotified(task.id, messageId, now)
}

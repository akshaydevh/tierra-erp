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

export async function queueTaskNotice(deps: AgentDeps, task: TaskRecord): Promise<void> {
  if (!needsNotice(task)) return
  await deps.enqueue({
    kind: 'task.notify',
    payload: { taskId: task.id },
    idempotencyKey: `task.notify:${task.id}:${task.assigneeId}`,
  })
}

/** Job handler: DMs the holder and remembers the notice so *done* or 👍 on it finishes the task. */
export async function sendTaskNotice(deps: AgentDeps, taskId: string): Promise<void> {
  const task = await deps.store.getTask(taskId)
  if (!task || !needsNotice(task) || task.notifiedAt) return
  const holder = (await deps.store.listAccountLinks()).find((account) => account.id === task.assigneeId)
  if (!holder?.phoneNumber) {
    console.warn(`Task ${task.id} was not sent: ${holder?.name ?? 'the holder'} has no linked phone`)
    return
  }
  const now = deps.now()
  const messageId = await sendDm(deps, holder.phoneNumber, taskNoticeText(task, raiserName(task), now), {
    purpose: 'task_notice',
    subjectType: 'task',
    subjectId: task.id,
  })
  await deps.store.markTaskNotified(task.id, messageId, now)
}

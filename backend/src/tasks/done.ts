import type { Role, TaskRecord } from '../db/types'

const DONE_WORDS = new Set(['done', 'completed', 'finished', 'ok done', '✅'])
const DONE_EMOJI = new Set(['👍', '✅', '👌'])
const SKIN_TONE_OR_VARIANT = /[\u{1F3FB}-\u{1F3FF}️]/gu

export function isDoneText(text: string | null | undefined): boolean {
  const value = (text ?? '')
    .trim()
    .toLowerCase()
    .replace(SKIN_TONE_OR_VARIANT, '')
    .replace(/[.!]+$/g, '')
    .replace(/[\s,]+/g, ' ')
  return DONE_WORDS.has(value)
}

export function isDoneEmoji(emoji: string | null | undefined): boolean {
  return DONE_EMOJI.has((emoji ?? '').replace(SKIN_TONE_OR_VARIANT, '').trim())
}

export function isOpenTask(task: TaskRecord): boolean {
  return task.status === 'todo' || task.status === 'doing'
}

/** The holder finishes a task; the admin may finish anyone's. */
export function canFinish(task: TaskRecord, person: { userId: string; role: Role }): boolean {
  return task.assigneeId === person.userId || person.role === 'admin'
}

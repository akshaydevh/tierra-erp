import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../db/types'
import { canFinish, isDoneEmoji, isDoneText } from './done'
import { dueLabel, needsNotice, taskNoticeText } from './notify'

const now = new Date('2026-09-26T04:00:00.000Z')

const task: TaskRecord = {
  id: 'tsk_1',
  title: 'Check CTN-TEST cartons',
  category: 'operations',
  status: 'todo',
  kind: 'todo',
  assigneeId: 'usr_joshy',
  assigneeName: 'Joshy',
  assigneeRole: 'manager',
  description: null,
  dueAt: '2026-09-26T11:30:00.000Z',
  subjectType: null,
  subjectId: null,
  notifiedAt: null,
  waMessageId: null,
  createdVia: 'dashboard',
  createdBy: 'usr_alex',
  createdByName: 'Alex Thomas',
  createdAt: '2026-09-26T04:00:00.000Z',
  completedAt: null,
  assignedAt: '2026-09-26T04:00:00.000Z',
}

describe('task notices', () => {
  it('names the raiser, the IST due time and how to finish', () => {
    expect(taskNoticeText(task, 'Alex', now)).toBe(
      'New task from Alex · due 17:00\n*Check CTN-TEST cartons*\nReply *done* to this message or react 👍 when it is finished.',
    )
    expect(taskNoticeText({ ...task, dueAt: null, description: 'Bay 3' }, 'Alex', now)).toBe(
      'New task from Alex\n*Check CTN-TEST cartons*\nBay 3\nReply *done* to this message or react 👍 when it is finished.',
    )
  })

  it('says tomorrow or the date for later due times', () => {
    expect(dueLabel('2026-09-27T03:30:00.000Z', now)).toBe('due tomorrow 09:00')
    expect(dueLabel('2026-10-02T12:00:00.000Z', now)).toBe('due 2 Oct 17:30')
  })

  it('skips approvals, unassigned and closed tasks', () => {
    expect(needsNotice(task)).toBe(true)
    expect(needsNotice({ ...task, kind: 'approval' })).toBe(false)
    expect(needsNotice({ ...task, assigneeId: null })).toBe(false)
    expect(needsNotice({ ...task, status: 'done' })).toBe(false)
  })

  it('recognises done words and emoji in any skin tone', () => {
    for (const text of ['done', 'Done.', 'COMPLETED', 'finished!', 'ok done', 'Ok, done', '✅']) {
      expect(isDoneText(text)).toBe(true)
    }
    for (const text of ['not done', 'done with lunch', '', 'ok']) expect(isDoneText(text)).toBe(false)
    for (const emoji of ['👍', '👍🏿', '✅', '👌🏽', '👍️']) expect(isDoneEmoji(emoji)).toBe(true)
    for (const emoji of ['👀', '❤️', '']) expect(isDoneEmoji(emoji)).toBe(false)
  })

  it('lets the holder or the admin finish a task', () => {
    expect(canFinish(task, { userId: 'usr_joshy', role: 'manager' })).toBe(true)
    expect(canFinish(task, { userId: 'usr_alex', role: 'admin' })).toBe(true)
    expect(canFinish(task, { userId: 'usr_anju', role: 'office' })).toBe(false)
  })
})

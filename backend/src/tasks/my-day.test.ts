import { describe, expect, it } from 'vitest'
import type { TaskRecord } from '../db/types'
import { myDay } from './my-day'

const base: TaskRecord = {
  id: 't', title: 'x', category: 'operations', status: 'todo', kind: 'todo', assigneeId: 'usr_joshy', assigneeName: 'Joshy',
  assigneeRole: 'manager', description: null, dueAt: null, subjectType: null, subjectId: null, notifiedAt: null, waMessageId: null,
  createdVia: 'dashboard', createdBy: 'usr_alex', createdByName: 'Alex', createdAt: '2026-10-08T03:00:00Z', completedAt: null,
  assignedAt: '2026-10-08T03:00:00Z',
}

describe('My Day', () => {
  it('splits into your move (by due), waiting on others and closed today (IST)', () => {
    const tasks: TaskRecord[] = [
      { ...base, id: 'later', dueAt: '2026-10-10T12:00:00Z' },
      { ...base, id: 'soon', dueAt: '2026-10-09T05:00:00Z' },
      { ...base, id: 'no-due', createdAt: '2026-10-08T05:00:00Z' },
      { ...base, id: 'role', assigneeId: 'usr_other', assigneeName: 'Other' },
      { ...base, id: 'office', assigneeId: 'usr_anju', assigneeRole: 'office' },
      { ...base, id: 'raised', assigneeId: 'usr_anju', assigneeRole: 'office', createdBy: 'usr_joshy' },
      { ...base, id: 'system', assigneeId: 'usr_anju', assigneeRole: 'office', createdBy: 'usr_joshy', createdVia: 'system' },
      { ...base, id: 'done-today', status: 'done', completedAt: '2026-10-08T20:00:00Z' },
      { ...base, id: 'done-yesterday', status: 'done', completedAt: '2026-10-08T18:00:00Z' },
    ]
    const day = myDay(tasks, { id: 'usr_joshy', role: 'manager' }, new Date('2026-10-09T04:00:00Z'))
    expect(day.open.map((task) => task.id)).toEqual(['soon', 'later', 'no-due', 'role'])
    expect(day.waiting.map((task) => task.id)).toEqual(['raised'])
    expect(day.closedToday.map((task) => task.id)).toEqual(['done-today'])
  })

  it('shows a task in one zone only: one raised for my own role is my move, not waiting', () => {
    const tasks: TaskRecord[] = [
      // Joshy raised it for the manager role while another manager holds it
      { ...base, id: 'own-role', assigneeId: 'usr_other', assigneeName: 'Other', createdBy: 'usr_joshy' },
      { ...base, id: 'own-role-unheld', assigneeId: null, assigneeName: null, createdBy: 'usr_joshy' },
      { ...base, id: 'office', assigneeId: 'usr_anju', assigneeRole: 'office', createdBy: 'usr_joshy' },
    ]
    const day = myDay(tasks, { id: 'usr_joshy', role: 'manager' }, new Date('2026-10-09T04:00:00Z'))
    expect(day.open.map((task) => task.id)).toEqual(['own-role', 'own-role-unheld'])
    expect(day.waiting.map((task) => task.id)).toEqual(['office'])
    const ids = [...day.open, ...day.waiting, ...day.closedToday].map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

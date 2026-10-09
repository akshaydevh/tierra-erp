'use client'

import { useEffect, useState } from 'react'
import {
  ROLES,
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_STATUS_LABELS,
  roleLabel,
  type AccountLink,
  type Role,
  type RoleHolders,
  type Task,
  type TaskCategory,
  type TaskStatus,
} from '@/lib/types'

const columns: TaskStatus[] = ['todo', 'doing', 'done']

type Board = { tasks: Task[]; accounts: AccountLink[]; holders: RoleHolders }
type Assignment = { assigneeId: string | null; assigneeRole: Role | null }
type TaskPatch = { status?: TaskStatus } | Assignment

function assignmentValue(task: Assignment): string {
  if (task.assigneeRole) return `role:${task.assigneeRole}`
  if (task.assigneeId) return `user:${task.assigneeId}`
  return ''
}

function parseAssignment(value: string): Assignment {
  if (value.startsWith('role:')) return { assigneeId: null, assigneeRole: value.slice(5) as Role }
  if (value.startsWith('user:')) return { assigneeId: value.slice(5), assigneeRole: null }
  return { assigneeId: null, assigneeRole: null }
}

function AssignOptions({ accounts, holders }: { accounts: AccountLink[]; holders: RoleHolders | null }) {
  return (
    <>
      <option value="">Unassigned</option>
      <optgroup label="Roles">
        {ROLES.map((role) => {
          const holder = holders?.[role]
          return (
            <option key={role} value={`role:${role}`}>
              {holder ? `${roleLabel(role)} (${holder.name})` : roleLabel(role)}
            </option>
          )
        })}
      </optgroup>
      <optgroup label="People">
        {accounts.map((account) => (
          <option key={account.id} value={`user:${account.id}`}>
            {account.name}
          </option>
        ))}
      </optgroup>
    </>
  )
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const timeFormat = new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' })
const dateFormat = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })

function DueChip({ task, now }: { task: Task; now: Date }) {
  if (!task.dueAt) return null
  const due = new Date(task.dueAt)
  const today = sameDay(due, now)
  const when = today ? `today ${timeFormat.format(due)}` : dateFormat.format(due)
  const open = task.status !== 'done'
  if (open && due < now) return <span className="pill coral">Overdue · {when}</span>
  return <span className={open && today ? 'pill amber' : 'pill grey'}>Due {when}</span>
}

export function TaskBoard() {
  const [board, setBoard] = useState<Board | null>(null)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<TaskCategory | ''>('')
  const [assignTo, setAssignTo] = useState('')
  const [dueAt, setDueAt] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState<TaskStatus | null>(null)

  async function load() {
    const response = await fetch('/api/tasks')
    if (!response.ok) throw new Error('Could not load tasks')
    setBoard((await response.json()) as Board)
  }

  useEffect(() => {
    let cancelled = false
    void fetch('/api/tasks')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load tasks')
        return response.json() as Promise<Board>
      })
      .then((body) => {
        if (!cancelled) setBoard(body)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load tasks')
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function createTask(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title,
          category,
          ...parseAssignment(assignTo),
          description: description.trim() || null,
          dueAt: dueAt ? new Date(dueAt).toISOString() : null,
        }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        setError(body.error ?? 'Could not add the task')
        return
      }
      setTitle('')
      setCategory('')
      setAssignTo('')
      setDueAt('')
      setDescription('')
      await load()
    } catch {
      setError('Could not add the task')
    } finally {
      setBusy(false)
    }
  }

  async function patchTask(id: string, patch: TaskPatch) {
    setError(null)
    const response = await fetch(`/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    const body = (await response.json()) as { error?: string }
    if (!response.ok) {
      setError(body.error ?? 'Could not update the task')
      return
    }
    await load()
  }

  function onDrop(status: TaskStatus, event: React.DragEvent) {
    event.preventDefault()
    setOver(null)
    const id = event.dataTransfer.getData('text/plain')
    const task = board?.tasks.find((row) => row.id === id)
    if (!task || task.status === status) return
    void patchTask(id, { status })
  }

  function cancelTask(task: Task) {
    if (!window.confirm(`Cancel "${task.title}"?`)) return
    void patchTask(task.id, { status: 'cancelled' })
  }

  const now = new Date()
  const accounts = board?.accounts ?? []
  const holders = board?.holders ?? null

  return (
    <div className="taskboard">
      <form className="taskform" onSubmit={(event) => void createTask(event)}>
        <label className="field">
          <span>Task</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="What needs doing" required />
        </label>
        <label className="field">
          <span>Category</span>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as TaskCategory | '')}
            required
          >
            <option value="">Choose</option>
            {TASK_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {TASK_CATEGORY_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Assign to</span>
          <select value={assignTo} onChange={(event) => setAssignTo(event.target.value)}>
            <AssignOptions accounts={accounts} holders={holders} />
          </select>
        </label>
        <label className="field">
          <span>Due (optional)</span>
          <input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </label>
        <label className="field taskdesc">
          <span>Description (optional)</span>
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Details the assignee should know"
          />
        </label>
        <button className="btn-pri" type="submit" disabled={busy}>
          Add task
        </button>
      </form>
      {error ? <p className="taskerr">{error}</p> : null}
      <div className="board">
        {columns.map((status) => (
          <section
            key={status}
            className={`boardcol${over === status ? ' over' : ''}`}
            onDragOver={(event) => {
              event.preventDefault()
              setOver(status)
            }}
            onDragLeave={() => setOver((current) => (current === status ? null : current))}
            onDrop={(event) => onDrop(status, event)}
          >
            <h4>
              {TASK_STATUS_LABELS[status]}
              <span>{board?.tasks.filter((task) => task.status === status).length ?? 0}</span>
            </h4>
            {(board?.tasks.filter((task) => task.status === status) ?? []).map((task) => (
              <article
                key={task.id}
                className="taskcard"
                draggable
                aria-label={task.title}
                onDragStart={(event) => event.dataTransfer.setData('text/plain', task.id)}
              >
                <b>{task.title}</b>
                {task.description ? <p className="taskdetail">{task.description}</p> : null}
                {task.subjectType === 'document' && task.subjectId ? (
                  <a
                    className="tasklink"
                    href={`/api/documents/${encodeURIComponent(task.subjectId)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PDF
                  </a>
                ) : null}
                <div className="taskchips">
                  <span className="pill grey">{TASK_CATEGORY_LABELS[task.category]}</span>
                  {task.assigneeRole ? <span className="pill ink">{roleLabel(task.assigneeRole)}</span> : null}
                  <DueChip task={task} now={now} />
                  {task.notifiedAt ? (
                    <span className="pill ok" title={`Sent ${dateFormat.format(new Date(task.notifiedAt))}`}>
                      Sent on WhatsApp
                    </span>
                  ) : null}
                </div>
                <div className="taskmeta">
                  <label className="taskassign">
                    <span className="sr">Assign {task.title} to</span>
                    <select
                      value={assignmentValue(task)}
                      onChange={(event) => void patchTask(task.id, parseAssignment(event.target.value))}
                    >
                      <AssignOptions accounts={accounts} holders={holders} />
                    </select>
                  </label>
                  <button
                    className="taskcancel"
                    type="button"
                    aria-label={`Cancel task ${task.title}`}
                    onClick={() => cancelTask(task)}
                  >
                    Cancel
                  </button>
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

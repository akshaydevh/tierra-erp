'use client'

import { useEffect, useState } from 'react'
import {
  TASK_CATEGORIES,
  TASK_CATEGORY_LABELS,
  TASK_STATUS_LABELS,
  type AccountLink,
  type Task,
  type TaskCategory,
  type TaskStatus,
} from '@/lib/types'

const columns: TaskStatus[] = ['todo', 'doing', 'done']

type Board = { tasks: Task[]; accounts: AccountLink[] }

export function TaskBoard() {
  const [board, setBoard] = useState<Board | null>(null)
  const [title, setTitle] = useState('')
  const [category, setCategory] = useState<TaskCategory | ''>('')
  const [assigneeId, setAssigneeId] = useState('')
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
          assigneeId: assigneeId || null,
        }),
      })
      const body = (await response.json()) as { error?: string }
      if (!response.ok) {
        setError(body.error ?? 'Could not add the task')
        return
      }
      setTitle('')
      setCategory('')
      setAssigneeId('')
      await load()
    } catch {
      setError('Could not add the task')
    } finally {
      setBusy(false)
    }
  }

  async function patchTask(id: string, patch: { status?: TaskStatus; assigneeId?: string | null }) {
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
          <span>Assignee</span>
          <select value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
            <option value="">Unassigned</option>
            {board?.accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
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
                <div className="taskmeta">
                  <span className="pill grey">{TASK_CATEGORY_LABELS[task.category]}</span>
                  <label className="taskassign">
                    <span className="sr">Assignee</span>
                    <select
                      value={task.assigneeId ?? ''}
                      onChange={(event) =>
                        void patchTask(task.id, { assigneeId: event.target.value || null })
                      }
                    >
                      <option value="">Unassigned</option>
                      {board?.accounts.map((account) => (
                        <option key={account.id} value={account.id}>
                          {account.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </article>
            ))}
          </section>
        ))}
      </div>
    </div>
  )
}

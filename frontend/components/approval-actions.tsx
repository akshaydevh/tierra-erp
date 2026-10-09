'use client'

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { ApprovalAction } from '@/lib/types'

// Approve / Send back / Reject on an approval task, Mark it done on a normal one.
// Decisions go through PATCH /api/tasks/:id. After an approve the customer copy goes out 60 s later; the
// notice with "Stop sending" lives in DecisionNotices at the top of the page, so it survives the refresh that
// moves the approved card out of the list.

const STOP_WINDOW_MS = 60_000

/** WhatsApp bold markers read badly on the dashboard. */
function plain(text: string): string {
  return text.replace(/\*/g, '')
}

/** Tell the nav badges to reload their counts. */
export function countsChanged() {
  window.dispatchEvent(new Event('tierra:counts'))
}

type TaskResult = { ok: true; message: string | null } | { ok: false; error: string }

async function patchTask(taskId: string, body: Record<string, unknown>): Promise<TaskResult> {
  try {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string }
    if (!response.ok) return { ok: false, error: data.error ?? `Could not update the task (${response.status})` }
    return { ok: true, message: data.message ? plain(data.message) : null }
  } catch {
    return { ok: false, error: 'Could not reach the server. Try again.' }
  }
}

type Notice = { id: number; taskId: string; text: string; tone: 'ok' | 'error'; stopUntil: number | null }

type NoticeApi = { push: (notice: Omit<Notice, 'id'>) => void }

const NoticeContext = createContext<NoticeApi | null>(null)

let nextId = 1

/** Page-level holder for decision messages and the 60 s "Stop sending" offer. */
export function DecisionNotices({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<Notice[]>([])
  const [now, setNow] = useState(() => Date.now())
  const router = useRouter()
  const ticking = notices.some((notice) => notice.stopUntil && notice.stopUntil > now)

  useEffect(() => {
    if (!ticking) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [ticking])

  function push(notice: Omit<Notice, 'id'>) {
    setNow(Date.now())
    setNotices((current) => [{ ...notice, id: nextId++ }, ...current].slice(0, 4))
  }

  function dismiss(id: number) {
    setNotices((current) => current.filter((notice) => notice.id !== id))
  }

  async function stop(notice: Notice) {
    setNotices((current) => current.map((row) => (row.id === notice.id ? { ...row, stopUntil: null } : row)))
    const result = await patchTask(notice.taskId, { action: 'stop' })
    push({
      taskId: notice.taskId,
      text: result.ok ? (result.message ?? 'Stopped.') : result.error,
      tone: result.ok ? 'ok' : 'error',
      stopUntil: null,
    })
    dismiss(notice.id)
    countsChanged()
    router.refresh()
  }

  return (
    <NoticeContext.Provider value={{ push }}>
      {notices.length ? (
        <div className="notices" role="status" aria-live="polite">
          {notices.map((notice) => {
            const left = notice.stopUntil ? Math.ceil((notice.stopUntil - now) / 1000) : 0
            return (
              <div key={notice.id} className={`notice ${notice.tone}`}>
                <p>{notice.text}</p>
                <span className="actions">
                  {left > 0 ? (
                    <button type="button" className="btn-danger" onClick={() => void stop(notice)}>
                      Stop sending ({left} s)
                    </button>
                  ) : null}
                  <button type="button" className="linkbtn" onClick={() => dismiss(notice.id)}>
                    Dismiss
                  </button>
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
      {children}
    </NoticeContext.Provider>
  )
}

type Mode = null | 'send_back' | 'reject'

/** Decision buttons for one pending approval task. */
export function ApprovalActions({
  taskId,
  docNo,
  allowReject = false,
}: {
  taskId: string
  docNo: string
  /** Reject is desk-only and final; the Approvals page offers it, My Day does not. */
  allowReject?: boolean
}) {
  const router = useRouter()
  const notices = useContext(NoticeContext)
  const [mode, setMode] = useState<Mode>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [local, setLocal] = useState<string | null>(null)

  async function decide(action: ApprovalAction) {
    if (busy) return
    const text = note.trim()
    if (action === 'send_back' && !text) {
      setError('Say what needs changing before sending it back.')
      return
    }
    if (action === 'reject') {
      if (!text) {
        setError('Give a reason for rejecting it.')
        return
      }
      if (!window.confirm(`Reject ${docNo}? This cancels the sales order and releases its stock. It cannot be undone.`)) return
    }
    setBusy(true)
    setError(null)
    const result = await patchTask(taskId, action === 'approve' ? { action } : { action, note: text })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const message = result.message ?? (action === 'approve' ? `Approved ${docNo}.` : action === 'send_back' ? `Sent ${docNo} back.` : `Rejected ${docNo}.`)
    const stopUntil = action === 'approve' ? Date.now() + STOP_WINDOW_MS : null
    if (notices) notices.push({ taskId, text: message, tone: 'ok', stopUntil })
    else setLocal(message)
    setMode(null)
    setNote('')
    countsChanged()
    router.refresh()
  }

  if (local) return <p className="note">{local}</p>

  return (
    <div className="apactions">
      {mode ? (
        <form
          className="apnote"
          onSubmit={(event) => {
            event.preventDefault()
            void decide(mode)
          }}
        >
          <label className="field">
            <span>{mode === 'send_back' ? 'What needs changing' : 'Reason for rejecting'}</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={1000}
              placeholder={mode === 'send_back' ? 'e.g. Use the new price list for the 150 g packs' : 'e.g. Customer cancelled the PO'}
              autoFocus
              required
            />
          </label>
          <span className="actions">
            <button type="submit" className={mode === 'reject' ? 'btn-danger' : 'btn-sec'} disabled={busy}>
              {mode === 'send_back' ? 'Send it back' : `Reject ${docNo}`}
            </button>
            <button
              type="button"
              className="linkbtn"
              onClick={() => {
                setMode(null)
                setError(null)
              }}
            >
              Cancel
            </button>
          </span>
        </form>
      ) : (
        <span className="actions">
          <button type="button" className="btn-pri btn-sm" disabled={busy} onClick={() => void decide('approve')}>
            Approve
          </button>
          <button type="button" className="btn-sec" disabled={busy} onClick={() => setMode('send_back')}>
            Send back
          </button>
          {allowReject ? (
            <button type="button" className="btn-danger" disabled={busy} onClick={() => setMode('reject')}>
              Reject
            </button>
          ) : null}
        </span>
      )}
      {error ? <p className="formerror">{error}</p> : null}
    </div>
  )
}

/** "Mark it done" for a normal task. */
export function DoneButton({ taskId, title }: { taskId: string; title: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function done() {
    setBusy(true)
    setError(null)
    const result = await patchTask(taskId, { status: 'done' })
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    countsChanged()
    router.refresh()
  }

  return (
    <span className="actions">
      <button type="button" className="btn-sec" disabled={busy} aria-label={`Mark "${title}" done`} onClick={() => void done()}>
        Mark it done
      </button>
      {error ? <span className="formerror">{error}</span> : null}
    </span>
  )
}

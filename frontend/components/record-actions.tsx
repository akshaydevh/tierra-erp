'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// Small destructive actions on Tierra's own records: cancel a TSO (admin) and cancel an unposted receipt.

async function post(path: string, body?: unknown): Promise<{ ok: true; message: string | null } | { ok: false; error: string }> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = (await response.json().catch(() => ({}))) as { message?: string; error?: string }
    if (!response.ok) return { ok: false, error: data.error ?? `Could not do that (${response.status})` }
    return { ok: true, message: data.message ? data.message.replace(/\*/g, '') : null }
  } catch {
    return { ok: false, error: 'Could not reach the server. Try again.' }
  }
}

/** "Cancel TSO": frees its stock and cancels its open tasks and procurement requests. */
export function CancelTsoButton({ orderId, docNo }: { orderId: string; docNo: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)

  async function cancel() {
    const note = window.prompt(`Cancel ${docNo}? Its stock is freed and its tasks and requests are cancelled. Reason (optional):`, '')
    if (note === null) return
    setBusy(true)
    const done = await post(`/api/sales-orders/${encodeURIComponent(orderId)}/cancel`, { note: note.trim() })
    setBusy(false)
    setResult(done.ok ? { tone: 'ok', text: done.message ?? 'Cancelled.' } : { tone: 'error', text: done.error })
    if (done.ok) router.refresh()
  }

  return (
    <span className="actions">
      <button type="button" className="btn-danger" disabled={busy} onClick={() => void cancel()}>
        Cancel TSO
      </button>
      {result ? (
        <span className={result.tone === 'error' ? 'formerror' : 'note'} role={result.tone === 'error' ? 'alert' : 'status'}>
          {result.text}
        </span>
      ) : null}
    </span>
  )
}

/** "Cancel" on an unposted receipt recorded by mistake: it stops counting as stock. */
export function CancelReceiptButton({ id, label }: { id: string; label: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function cancel() {
    if (!window.confirm(`Cancel the unposted receipt ${label}? It stops counting as stock.`)) return
    setBusy(true)
    setError(null)
    const done = await post(`/api/stock-adjustments/${encodeURIComponent(id)}/cancel`)
    setBusy(false)
    if (!done.ok) {
      setError(done.error)
      return
    }
    router.refresh()
  }

  return (
    <>
      <button type="button" className="btn-sec" disabled={busy} onClick={() => void cancel()}>
        Cancel
      </button>
      {error ? (
        <span className="formerror" role="alert">
          {error}
        </span>
      ) : null}
    </>
  )
}

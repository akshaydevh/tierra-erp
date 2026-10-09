'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

// The units as SAP spells them (erp.items.uom); the backend compares the choice with the item's own unit.
const UNITS: { value: string; label: string }[] = [
  { value: '', label: 'Item’s own unit' },
  { value: 'kg', label: 'kg' },
  { value: 'pcs', label: 'pcs' },
  { value: 'nos', label: 'nos' },
  { value: 'ltr', label: 'litres' },
  { value: 'kl', label: 'kilolitres' },
  { value: 'rolls', label: 'rolls' },
]

/** "Record a receipt": stock that arrived before SAP knows about it. Counted as unposted until the next import. */
export function ReceiptForm() {
  const router = useRouter()
  const [itemCode, setItemCode] = useState('')
  const [qty, setQty] = useState('')
  const [unit, setUnit] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const amount = Number(qty)
    if (!itemCode.trim() || !Number.isFinite(amount) || amount <= 0) {
      setError('Give an item code and a quantity above zero.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const response = await fetch('/api/stock-adjustments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ itemCode: itemCode.trim(), qty: amount, unit: unit || null }),
      })
      const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string }
      if (!response.ok) {
        setError(body.error ?? 'Could not record the receipt')
        return
      }
      setMessage((body.message ?? 'Recorded.').replace(/\*/g, ''))
      setItemCode('')
      setQty('')
      setUnit('')
      router.refresh()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card p6 receipt">
      <form className="receiptform" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span>Item code</span>
          <input
            value={itemCode}
            onChange={(event) => setItemCode(event.target.value.toUpperCase())}
            placeholder="e.g. ZPMLMA"
            autoComplete="off"
            required
          />
        </label>
        <label className="field">
          <span>Quantity</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={qty}
            onChange={(event) => setQty(event.target.value)}
            placeholder="20"
            required
          />
        </label>
        <label className="field">
          <span>Unit</span>
          <select value={unit} onChange={(event) => setUnit(event.target.value)}>
            {UNITS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button className="btn-pri" type="submit" disabled={busy}>
          Record a receipt
        </button>
      </form>
      {error ? <p className="formerror">{error}</p> : null}
      {message ? (
        <p className="note pre" role="status">
          {message}
        </p>
      ) : null}
    </div>
  )
}

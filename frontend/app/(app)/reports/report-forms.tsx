'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { MANPOWER_KEYS, MANPOWER_LABELS, OUTWARDS_BASES, type DailyInputs, type OutwardsBasis } from '@/lib/types'

type Flag = 'sap' | 'yes' | 'no'

function flagOf(value: boolean | null | undefined): Flag {
  return value == null ? 'sap' : value ? 'yes' : 'no'
}

function flagValue(flag: Flag): boolean | null {
  return flag === 'sap' ? null : flag === 'yes'
}

function numberOrNull(value: string): number | null {
  const n = Number(value)
  return value.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null
}

/** The day's inputs SAP does not have: manpower, gate estimates, flag overrides, remarks and notes. */
export function InputsForm({ date, inputs, canEdit }: { date: string; inputs: DailyInputs | null; canEdit: boolean }) {
  const router = useRouter()
  const [manpower, setManpower] = useState<Record<string, string>>(
    Object.fromEntries(MANPOWER_KEYS.map((key) => [key, inputs?.manpower ? String(inputs.manpower[key] ?? 0) : ''])),
  )
  const [banana, setBanana] = useState(inputs?.bananaKgEstimate != null ? String(inputs.bananaKgEstimate) : '')
  const [cassava, setCassava] = useState(inputs?.cassavaKgEstimate != null ? String(inputs.cassavaKgEstimate) : '')
  const [flags, setFlags] = useState<Record<'productionRun' | 'packingRun' | 'cartoningRun', Flag>>({
    productionRun: flagOf(inputs?.productionRun),
    packingRun: flagOf(inputs?.packingRun),
    cartoningRun: flagOf(inputs?.cartoningRun),
  })
  const [bananaRemark, setBananaRemark] = useState(inputs?.inwardRemarks?.banana ?? '')
  const [notes, setNotes] = useState(inputs?.notes ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  const filled = MANPOWER_KEYS.filter((key) => manpower[key]?.trim() !== '')
  const total = MANPOWER_KEYS.reduce((sum, key) => sum + (Number(manpower[key]) || 0), 0)

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy || !canEdit) return
    if (filled.length > 0 && filled.length < MANPOWER_KEYS.length) {
      setError('Fill in all eight manpower boxes (0 where nobody came), or leave them all empty.')
      return
    }
    if (MANPOWER_KEYS.some((key) => manpower[key]?.trim() && !/^\d+$/.test(manpower[key]!.trim()))) {
      setError('Manpower counts are whole numbers.')
      return
    }
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const body = {
        manpower: filled.length ? Object.fromEntries(MANPOWER_KEYS.map((key) => [key, Number(manpower[key])])) : null,
        bananaKgEstimate: numberOrNull(banana),
        cassavaKgEstimate: numberOrNull(cassava),
        productionRun: flagValue(flags.productionRun),
        packingRun: flagValue(flags.packingRun),
        cartoningRun: flagValue(flags.cartoningRun),
        inwardRemarks: { ...(inputs?.inwardRemarks ?? {}), banana: bananaRemark.trim() },
        notes: notes.trim() || null,
      }
      const response = await fetch(`/api/reports/daily-inputs/${date}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        setError(result.error ?? 'Could not save the inputs')
        return
      }
      setMessage(filled.length ? `Saved, total ${total}.` : 'Saved.')
      router.refresh()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const flagSelect = (key: keyof typeof flags, label: string) => (
    <label className="field">
      <span>{label}</span>
      <select value={flags[key]} disabled={!canEdit} onChange={(event) => setFlags({ ...flags, [key]: event.target.value as Flag })}>
        <option value="sap">As SAP shows</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </label>
  )

  return (
    <form className="card p6 inputsform" onSubmit={(event) => void save(event)}>
      <fieldset disabled={!canEdit || busy}>
        <legend>Manpower {filled.length === MANPOWER_KEYS.length ? <b className="num">· total {total}</b> : null}</legend>
        <div className="mpgrid">
          {MANPOWER_KEYS.map((key) => (
            <label className="field" key={key}>
              <span>{MANPOWER_LABELS[key]}</span>
              <input
                inputMode="numeric"
                value={manpower[key] ?? ''}
                onChange={(event) => setManpower({ ...manpower, [key]: event.target.value })}
                placeholder="0"
              />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset disabled={!canEdit || busy}>
        <legend>Inwards and the day</legend>
        <div className="mpgrid">
          <label className="field">
            <span>Banana at the gate (kg)</span>
            <input inputMode="decimal" value={banana} onChange={(event) => setBanana(event.target.value)} placeholder="11000" />
          </label>
          <label className="field">
            <span>Cassava at the gate (kg)</span>
            <input inputMode="decimal" value={cassava} onChange={(event) => setCassava(event.target.value)} placeholder="0" />
          </label>
          <label className="field">
            <span>Banana remark</span>
            <input value={bananaRemark} onChange={(event) => setBananaRemark(event.target.value)} maxLength={300} />
          </label>
          {flagSelect('productionRun', 'Production')}
          {flagSelect('packingRun', 'Packing')}
          {flagSelect('cartoningRun', 'Cartoning')}
        </div>
        <label className="field">
          <span>Notes</span>
          <input value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={1000} />
        </label>
      </fieldset>
      {canEdit ? (
        <div className="actions">
          <button className="btn-pri" type="submit" disabled={busy}>
            Save inputs
          </button>
          <span className="stamp">
            {inputs?.enteredAt ? `Last saved by ${inputs.enteredByName ?? 'someone'}` : 'Or send *manpower 7 6 6 7 19 25 2 13* / *banana 11t* to Tierra Bot.'}
          </span>
        </div>
      ) : (
        <p className="note">The office (QA) or the admin enters these.</p>
      )}
      {error ? <p className="formerror">{error}</p> : null}
      {message ? (
        <p className="note" role="status">
          {message}
        </p>
      ) : null}
    </form>
  )
}

/** Send the PDF to the signed-in person's WhatsApp. */
export function SendToWhatsapp({ date }: { date: string }) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  async function send() {
    setBusy(true)
    setStatus(null)
    try {
      const response = await fetch(`/api/reports/daily/${date}/send`, { method: 'POST' })
      const body = (await response.json().catch(() => ({}))) as { message?: string; error?: string }
      setStatus(response.ok ? { ok: true, text: body.message ?? 'Sent.' } : { ok: false, text: body.error ?? 'Could not send it' })
    } catch {
      setStatus({ ok: false, text: 'Could not reach the server. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button type="button" className="btn-sec" onClick={() => void send()} disabled={busy}>
        {busy ? 'Sending…' : 'Send to my WhatsApp'}
      </button>
      {status ? (
        <span className={status.ok ? 'stamp' : 'formerror'} role="status">
          {status.text}
        </span>
      ) : null}
    </>
  )
}

const BASIS_LABELS: Record<OutwardsBasis, string> = {
  created_window: 'Keyed by the evening cut-off (like the sheet)',
  doc_date: 'Invoice date',
  ewb_date: 'E-way bill date',
}

/** Admin: how the outwards block picks a day's invoices. */
export function BasisSelect({ basis }: { basis: OutwardsBasis }) {
  const router = useRouter()
  const [value, setValue] = useState(basis)
  const [error, setError] = useState<string | null>(null)

  async function change(next: OutwardsBasis) {
    setValue(next)
    setError(null)
    const response = await fetch('/api/reports/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outwardsBasis: next }),
    }).catch(() => null)
    if (!response?.ok) {
      setError('Could not change it')
      setValue(basis)
      return
    }
    router.refresh()
  }

  return (
    <label className="daypick">
      <span>Outwards by</span>
      <select value={value} onChange={(event) => void change(event.target.value as OutwardsBasis)}>
        {OUTWARDS_BASES.map((option) => (
          <option key={option} value={option}>
            {BASIS_LABELS[option]}
          </option>
        ))}
      </select>
      {error ? <span className="formerror">{error}</span> : null}
    </label>
  )
}

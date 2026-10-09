'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { CustomerPoLine, ItemRow, PartyRow } from '@/lib/types'

// The office's review of a PO that needs one: set the customer card (search /api/parties), confirm the Tierra item of
// each line that is not matched or matched by name only (search /api/items), then "Confirm and check": the PO is
// checked again and carries on to the sales order, a hold or the admin's *proceed*, exactly like a fresh one.

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null
}

function useSearch<T>(path: string, query: string, pick: (rows: T[]) => T[]): T[] {
  const [rows, setRows] = useState<T[]>([])
  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setRows([])
      return
    }
    const timer = window.setTimeout(async () => {
      const response = await fetch(`${path}?q=${encodeURIComponent(q)}`).catch(() => null)
      if (!response?.ok) return
      setRows(pick((await readJson<{ rows: T[] }>(response))?.rows ?? []))
    }, 250)
    return () => window.clearTimeout(timer)
    // pick is a stable filter per caller
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, query])
  return rows
}

type LineDraft = { itemCode: string; pcsPerUom: string }

function needsItem(line: CustomerPoLine): boolean {
  return !line.itemCode || !line.matchConfirmed || line.pcs === null
}

function LinePicker({ line, draft, onChange }: { line: CustomerPoLine; draft: LineDraft; onChange: (next: LineDraft) => void }) {
  const [query, setQuery] = useState('')
  const items = useSearch<ItemRow>('/api/items', query, (rows) => rows.filter((row) => row.materialRole === 'fg').slice(0, 6))
  return (
    <li className="rel" style={{ gridTemplateColumns: '1fr', gap: 8 }}>
      <div>
        <b>
          Line {line.lineNo}: {line.articleNo ? `${line.articleNo} · ` : ''}
          {line.description}
        </b>
        <div className="stamp">
          {line.qty} {line.uom ?? ''}
          {line.itemCode ? ` · now ${line.itemCode}${line.matchConfirmed ? '' : ' (name only)'}` : ' · not matched'}
          {line.note ? ` · ${line.note}` : ''}
        </div>
      </div>
      <div className="rel" style={{ gridTemplateColumns: '1fr 160px 160px', borderTop: 'none', padding: 0 }}>
        <div className="field">
          <label htmlFor={`line-${line.lineNo}-search`}>Find the Tierra item</label>
          <input id={`line-${line.lineNo}-search`} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Code or name" autoComplete="off" />
        </div>
        <div className="field">
          <label htmlFor={`line-${line.lineNo}-code`}>Item code</label>
          <input
            id={`line-${line.lineNo}-code`}
            value={draft.itemCode}
            onChange={(event) => onChange({ ...draft, itemCode: event.target.value.toUpperCase() })}
            placeholder={line.itemCode ?? 'FG…'}
          />
        </div>
        <div className="field">
          <label htmlFor={`line-${line.lineNo}-pcs`}>Pieces per {line.uom ?? 'unit'} (if SAP cannot tell)</label>
          <input
            id={`line-${line.lineNo}-pcs`}
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={draft.pcsPerUom}
            onChange={(event) => onChange({ ...draft, pcsPerUom: event.target.value })}
          />
        </div>
      </div>
      {items.length ? (
        <div className="pills" aria-label={`Matching items for line ${line.lineNo}`}>
          {items.map((item) => (
            <button
              key={item.itemCode}
              type="button"
              className="pill ink"
              style={{ border: 'none', cursor: 'pointer' }}
              onClick={() => {
                onChange({ ...draft, itemCode: item.itemCode })
                setQuery('')
              }}
            >
              {item.itemCode} {item.itemName}
              {item.pcsPerCarton ? ` · ${item.pcsPerCarton}/carton` : ''}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  )
}

export function PoReview({ poId, cardCode, cardName, lines }: { poId: string; cardCode: string | null; cardName: string | null; lines: CustomerPoLine[] }) {
  const router = useRouter()
  const [cardQuery, setCardQuery] = useState('')
  const parties = useSearch<PartyRow>('/api/parties', cardQuery, (rows) => rows.filter((row) => row.cardType === 'customer').slice(0, 6))
  const [card, setCard] = useState<{ code: string; name: string | null } | null>(cardCode ? { code: cardCode, name: cardName } : null)
  const open = lines.filter(needsItem)
  const [drafts, setDrafts] = useState<Record<number, LineDraft>>(() =>
    Object.fromEntries(open.map((line) => [line.lineNo, { itemCode: line.itemCode ?? '', pcsPerUom: '' }])),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

  async function send(path: string, method: 'PUT' | 'POST', body?: unknown): Promise<{ message?: string } | null> {
    const response = await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    const data = await readJson<{ error?: string; message?: string }>(response)
    if (!response.ok) {
      setError(data?.error ?? `Could not save (${response.status})`)
      return null
    }
    return data ?? {}
  }

  async function save(): Promise<boolean> {
    const changedCard = card && card.code !== cardCode
    const confirmed = open
      .map((line) => ({ line, draft: drafts[line.lineNo] }))
      .filter(({ draft }) => draft && draft.itemCode.trim())
      .map(({ line, draft }) => ({
        lineNo: line.lineNo,
        itemCode: draft!.itemCode.trim(),
        pcsPerUom: Number(draft!.pcsPerUom) > 0 ? Number(draft!.pcsPerUom) : null,
      }))
    if (!changedCard && !confirmed.length) return true
    const saved = await send(`/api/customer-pos/${encodeURIComponent(poId)}/review`, 'PUT', {
      ...(changedCard ? { cardCode: card!.code } : {}),
      ...(confirmed.length ? { lines: confirmed } : {}),
    })
    return saved !== null
  }

  async function run(confirm: boolean) {
    if (busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      if (!(await save())) return
      if (confirm) {
        const done = await send(`/api/customer-pos/${encodeURIComponent(poId)}/confirm`, 'POST')
        if (!done) return
        setMessage((done.message ?? 'Confirmed.').replace(/\*/g, ''))
      } else {
        setMessage('Saved.')
      }
      router.refresh()
    } catch {
      setError('Could not reach the server. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="card p6" style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 16 }} aria-label="Review this PO">
      <b>Review</b>
      <div>
        <div className="stamp" style={{ marginBottom: 8 }}>
          Customer card: {card ? `${card.code}${card.name ? ` ${card.name}` : ''}` : 'not set'}
        </div>
        <div className="field">
          <label htmlFor="po-card-search">Find the SAP customer card</label>
          <input id="po-card-search" value={cardQuery} onChange={(event) => setCardQuery(event.target.value)} placeholder="Name, card code or GSTIN" autoComplete="off" />
        </div>
        {parties.length ? (
          <div className="pills" style={{ marginTop: 8 }} aria-label="Matching SAP customers">
            {parties.map((row) => (
              <button
                key={row.cardCode}
                type="button"
                className="pill ink"
                style={{ border: 'none', cursor: 'pointer' }}
                onClick={() => {
                  setCard({ code: row.cardCode, name: row.cardName })
                  setCardQuery('')
                }}
              >
                {row.cardCode} {row.cardName}
                {row.city ? ` · ${row.city}` : ''}
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {open.length ? (
        <ul className="rels" aria-label="Lines to confirm">
          {open.map((line) => (
            <LinePicker
              key={line.lineNo}
              line={line}
              draft={drafts[line.lineNo] ?? { itemCode: '', pcsPerUom: '' }}
              onChange={(next) => setDrafts((current) => ({ ...current, [line.lineNo]: next }))}
            />
          ))}
        </ul>
      ) : (
        <p className="stamp">Every line has a confirmed Tierra item.</p>
      )}
      {error ? <p className="formerror">{error}</p> : null}
      {message ? (
        <p className="note" role="status">
          {message}
        </p>
      ) : null}
      <div className="actions">
        <button type="button" className="btn-pri" disabled={busy} onClick={() => void run(true)}>
          Confirm and check
        </button>
        <button type="button" className="btn-sec" disabled={busy} onClick={() => void run(false)}>
          Save
        </button>
      </div>
    </article>
  )
}

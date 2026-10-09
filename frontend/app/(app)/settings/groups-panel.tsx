'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Me, PartyGroup, PartyMember, PartyRow, WaGroupRow } from '@/lib/types'

type Draft = { id: string | null; name: string; alias: string; members: PartyMember[] }

const EMPTY: Draft = { id: null, name: '', alias: '', members: [] }

function memberLabel(member: PartyMember): string {
  return member.kind === 'pan' ? `PAN ${member.value}` : `${member.value}${member.name ? ` ${member.name}` : ''}`
}

async function readJson<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null
}

/** The party-group editor: a name, a short name, and its PANs (every branch card) and / or single card codes. */
function PartyEditor({ draft, onCancel, onSaved }: { draft: Draft; onCancel: () => void; onSaved: () => void }) {
  const [value, setValue] = useState<Draft>(draft)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<PartyRow[]>([])
  const [pan, setPan] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => setValue(draft), [draft])

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      return
    }
    const timer = window.setTimeout(async () => {
      const response = await fetch(`/api/parties?q=${encodeURIComponent(q)}`)
      if (!response.ok) return
      const body = await readJson<{ rows: PartyRow[] }>(response)
      setResults((body?.rows ?? []).filter((row) => row.cardType === 'customer').slice(0, 8))
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])

  function add(member: PartyMember) {
    setValue((current) =>
      current.members.some((row) => row.kind === member.kind && row.value === member.value)
        ? current
        : { ...current, members: [...current.members, member] },
    )
  }

  function remove(member: PartyMember) {
    setValue((current) => ({
      ...current,
      members: current.members.filter((row) => !(row.kind === member.kind && row.value === member.value)),
    }))
  }

  async function save() {
    setPending(true)
    setError('')
    const response = await fetch(value.id ? `/api/party-groups/${value.id}` : '/api/party-groups', {
      method: value.id ? 'PUT' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: value.name,
        alias: value.alias || null,
        members: value.members.map(({ kind, value: code }) => ({ kind, value: code })),
      }),
    })
    setPending(false)
    if (!response.ok) {
      setError((await readJson<{ error?: string }>(response))?.error ?? 'Could not save the party group')
      return
    }
    onSaved()
  }

  return (
    <article className="card p6" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760 }}>
      <b>{value.id ? `Edit ${draft.name}` : 'New party group'}</b>
      <div className="rel" style={{ gridTemplateColumns: '1fr 1fr', borderTop: 'none', padding: 0 }}>
        <div className="field">
          <label htmlFor="pg-name">Name</label>
          <input id="pg-name" value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} placeholder="Northwind Retail" />
        </div>
        <div className="field">
          <label htmlFor="pg-alias">Short name (optional)</label>
          <input id="pg-alias" value={value.alias} onChange={(event) => setValue({ ...value, alias: event.target.value })} placeholder="Northwind" />
        </div>
      </div>
      <div>
        <div className="stamp" style={{ marginBottom: 8 }}>
          Members: a PAN covers every SAP card of that company (its bill-to GSTIN); a card code adds one card.
        </div>
        <div className="pills">
          {value.members.length === 0 ? <span className="stamp">No members yet.</span> : null}
          {value.members.map((member) => (
            <button
              key={`${member.kind}:${member.value}`}
              type="button"
              className="pill ink"
              title="Remove"
              onClick={() => remove(member)}
              style={{ border: 'none', cursor: 'pointer' }}
            >
              {memberLabel(member)} ×
            </button>
          ))}
        </div>
      </div>
      <div className="rel" style={{ gridTemplateColumns: '1fr 220px auto', borderTop: 'none', padding: 0 }}>
        <div className="field">
          <label htmlFor="pg-search">Find a SAP customer</label>
          <input
            id="pg-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, card code, GSTIN or PAN"
            autoComplete="off"
          />
        </div>
        <div className="field">
          <label htmlFor="pg-pan">Or type a PAN</label>
          <input id="pg-pan" value={pan} onChange={(event) => setPan(event.target.value.toUpperCase())} placeholder="AAACN9999Q" />
        </div>
        <button
          type="button"
          className="btn-sec"
          disabled={!/^[A-Z]{5}\d{4}[A-Z]$/.test(pan.trim())}
          onClick={() => {
            add({ kind: 'pan', value: pan.trim() })
            setPan('')
          }}
        >
          Add PAN
        </button>
      </div>
      {results.length ? (
        <ul className="rels" aria-label="Matching SAP customers">
          {results.map((row) => (
            <li key={row.cardCode} className="rel" style={{ gridTemplateColumns: '1fr auto' }}>
              <div>
                <b>
                  {row.cardCode} {row.cardName}
                </b>
                <div className="stamp">{[row.city, row.gstin].filter(Boolean).join(' · ') || 'No GSTIN'}</div>
              </div>
              <div className="actions">
                <button type="button" className="btn-sec" onClick={() => add({ kind: 'card_code', value: row.cardCode, name: row.cardName })}>
                  Add card
                </button>
                {row.pan ? (
                  <button type="button" className="btn-sec" onClick={() => add({ kind: 'pan', value: row.pan! })}>
                    Add PAN {row.pan}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="formerror">{error}</p> : null}
      <div className="actions">
        <button type="button" className="btn-pri" disabled={pending || !value.name.trim()} onClick={() => void save()}>
          Save
        </button>
        <button type="button" className="btn-sec" disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </article>
  )
}

/** Settings: which WhatsApp group speaks for which customer, and the customers (party groups) themselves. */
export function GroupsPanel({ me }: { me: Me }) {
  const canManage = me.role === 'admin'
  const [parties, setParties] = useState<PartyGroup[]>([])
  const [groups, setGroups] = useState<WaGroupRow[]>([])
  const [drafts, setDrafts] = useState<Record<string, { partyGroupId: string; sendSo: boolean }>>({})
  const [gatewayError, setGatewayError] = useState('')
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<Draft | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [partyError, setPartyError] = useState('')

  const loadParties = useCallback(async () => {
    const response = await fetch('/api/party-groups')
    if (!response.ok) return
    setParties((await readJson<{ partyGroups: PartyGroup[] }>(response))?.partyGroups ?? [])
  }, [])

  const loadGroups = useCallback(async () => {
    if (!canManage) return
    const response = await fetch('/api/whatsapp/groups')
    const body = await readJson<{ groups?: WaGroupRow[]; error?: string }>(response)
    setGroups(body?.groups ?? [])
    setGatewayError(body?.error ?? (response.ok ? '' : 'Could not load WhatsApp groups'))
  }, [canManage])

  useEffect(() => {
    void loadParties()
    void loadGroups()
  }, [loadParties, loadGroups])

  async function saveGroup(group: WaGroupRow) {
    const draft = drafts[group.id] ?? { partyGroupId: group.partyGroupId ?? '', sendSo: group.sendSo }
    setPendingId(group.id)
    setRowErrors((current) => ({ ...current, [group.id]: '' }))
    const response = await fetch(`/api/whatsapp/groups/${encodeURIComponent(group.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ partyGroupId: draft.partyGroupId || null, sendSo: draft.sendSo }),
    })
    setPendingId(null)
    if (!response.ok) {
      const message = (await readJson<{ error?: string }>(response))?.error ?? 'Could not save'
      setRowErrors((current) => ({ ...current, [group.id]: message }))
      return
    }
    setDrafts((current) => {
      const next = { ...current }
      delete next[group.id]
      return next
    })
    await loadGroups()
  }

  async function removeParty(party: PartyGroup) {
    if (!window.confirm(`Delete the party group ${party.name}? WhatsApp groups linked to it become unlinked.`)) return
    setPartyError('')
    try {
      const response = await fetch(`/api/party-groups/${party.id}`, { method: 'DELETE' })
      if (!response.ok) {
        setPartyError((await readJson<{ error?: string }>(response))?.error ?? `Could not delete ${party.name} (${response.status})`)
        return
      }
    } catch {
      setPartyError(`Could not reach the server to delete ${party.name}. Try again.`)
      return
    }
    await Promise.all([loadParties(), loadGroups()])
  }

  return (
    <>
      <section className="sec">
        <div className="sechead">
          <div>
            <h3>WhatsApp groups</h3>
            <p>
              Link each customer&apos;s WhatsApp group to its party group. In a linked group Tierra Bot reads purchase-order PDFs
              without a mention and answers questions about that customer only. Send SO controls whether approved sales orders
              go to the group.
            </p>
          </div>
          <span className="zid">Customers</span>
        </div>
        <article className="card p6" style={{ maxWidth: 760 }}>
          {!canManage ? <p className="stamp">An admin can link WhatsApp groups to customers.</p> : null}
          {canManage && gatewayError ? <p className="formerror" style={{ marginBottom: 12 }}>{gatewayError}</p> : null}
          {canManage && groups.length === 0 && !gatewayError ? <p className="stamp">Tierra Bot is not in any WhatsApp group yet.</p> : null}
          <div className="rels">
            {groups.map((group) => {
              const draft = drafts[group.id] ?? { partyGroupId: group.partyGroupId ?? '', sendSo: group.sendSo }
              const pending = pendingId === group.id
              return (
                <div className="rel withrole" key={group.id}>
                  <div>
                    <div className="relname">
                      <b>{group.subject}</b>
                      {group.partyGroupId ? <span className="pill ok">Linked</span> : <span className="pill amber">Not linked</span>}
                    </div>
                    <div className="stamp">
                      {group.size !== null ? `${group.size} members` : group.inGroup === false ? 'Bot no longer in this group' : 'Known from earlier messages'}
                    </div>
                    {rowErrors[group.id] ? <p className="formerror">{rowErrors[group.id]}</p> : null}
                  </div>
                  <div className="field">
                    <label className="sr" htmlFor={`party-${group.id}`}>
                      Party group for {group.subject}
                    </label>
                    <select
                      id={`party-${group.id}`}
                      value={draft.partyGroupId}
                      disabled={pending}
                      onChange={(event) => setDrafts((current) => ({ ...current, [group.id]: { ...draft, partyGroupId: event.target.value } }))}
                    >
                      <option value="">Not linked</option>
                      {parties.map((party) => (
                        <option key={party.id} value={party.id}>
                          {party.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <label className="stamp" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={draft.sendSo}
                      disabled={pending}
                      onChange={(event) => setDrafts((current) => ({ ...current, [group.id]: { ...draft, sendSo: event.target.checked } }))}
                    />
                    Send SO
                  </label>
                  <div className="actions">
                    <button className="btn-pri" type="button" disabled={pending || !drafts[group.id]} onClick={() => void saveGroup(group)}>
                      Save
                    </button>
                  </div>
                </div>
              )
            })}
          </div>
        </article>
      </section>

      <section className="sec">
        <div className="sechead">
          <div>
            <h3>Party groups</h3>
            <p>
              A party group is one customer as Tierra sees it: its PANs (every branch card of the company) and single SAP card
              codes. Delivery sites and article refs come from setup and are shown read-only.
            </p>
          </div>
          {canManage && !editing ? (
            <div className="secside">
              <button className="btn-pri" type="button" onClick={() => setEditing({ ...EMPTY })}>
                New party group
              </button>
            </div>
          ) : null}
        </div>
        {editing ? (
          <PartyEditor
            draft={editing}
            onCancel={() => setEditing(null)}
            onSaved={() => {
              setEditing(null)
              void loadParties()
              void loadGroups()
            }}
          />
        ) : null}
        <article className="card p6" style={{ maxWidth: 760 }}>
          {partyError ? (
            <p className="formerror" role="alert" style={{ marginBottom: 12 }}>
              {partyError}
            </p>
          ) : null}
          {parties.length === 0 ? <p className="stamp">No party groups yet.</p> : null}
          <div className="rels">
            {parties.map((party) => (
              <div className="rel" key={party.id} style={{ gridTemplateColumns: '1fr auto' }}>
                <div>
                  <div className="relname">
                    <b>{party.name}</b>
                    {party.alias && party.alias !== party.name ? <span className="pill grey">{party.alias}</span> : null}
                  </div>
                  <div className="pills" style={{ marginTop: 6 }}>
                    {party.members.map((member) => (
                      <span key={`${member.kind}:${member.value}`} className="pill ink">
                        {memberLabel(member)}
                      </span>
                    ))}
                  </div>
                  {party.sites?.length ? (
                    <div className="stamp" style={{ marginTop: 6 }}>
                      Sites: {party.sites.map((site) => `${site.siteCode} → ${site.cardCode}${site.cardName ? ` ${site.cardName}` : ''}`).join('; ')}
                    </div>
                  ) : null}
                  {party.itemRefs?.length ? (
                    <div className="stamp" style={{ marginTop: 4 }}>
                      Article refs:{' '}
                      {party.itemRefs
                        .map((ref) => `${ref.articleNo ?? ref.ean} → ${ref.itemCode}${ref.buyerUom ? ` (${ref.buyerUom} = ${ref.pcsPerUom ?? '?'} pcs)` : ''}`)
                        .join('; ')}
                    </div>
                  ) : null}
                </div>
                {canManage ? (
                  <div className="actions">
                    <button
                      className="btn-sec"
                      type="button"
                      onClick={() => setEditing({ id: party.id, name: party.name, alias: party.alias ?? '', members: party.members })}
                    >
                      Edit
                    </button>
                    <button className="btn-danger" type="button" onClick={() => void removeParty(party)}>
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </article>
      </section>
    </>
  )
}

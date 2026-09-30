'use client'

import { useCallback, useEffect, useState } from 'react'
import type { AccountLink, WhatsappConnection } from '@/lib/types'

function statusLabel(status: WhatsappConnection['status']): string {
  if (status === 'connected') return 'Connected'
  if (status === 'qr_pending') return 'Waiting for scan'
  return 'Not connected'
}

function pillClass(status: WhatsappConnection['status']): string {
  if (status === 'connected') return 'pill ok'
  if (status === 'qr_pending') return 'pill amber'
  return 'pill grey'
}

function roleLabel(role: AccountLink['role']): string {
  return role === 'admin' ? 'Admin' : 'Office'
}

function Relations({ canManage }: { canManage: boolean }) {
  const [accounts, setAccounts] = useState<AccountLink[]>([])
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [pendingId, setPendingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const response = await fetch('/api/relations')
    if (!response.ok) return
    const body = (await response.json()) as { accounts: AccountLink[] }
    setAccounts(body.accounts)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function save(account: AccountLink, phoneNumber: string) {
    setPendingId(account.id)
    setError('')
    const response = await fetch('/api/relations', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: account.id, phoneNumber }),
    })
    setPendingId(null)
    const body = (await response.json().catch(() => null)) as { error?: string; accounts?: AccountLink[] } | null
    if (!response.ok) {
      setError(body?.error ?? 'Could not save that number')
      return
    }
    if (body?.accounts) setAccounts(body.accounts)
    setDrafts((current) => {
      const next = { ...current }
      delete next[account.id]
      return next
    })
  }

  return (
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>Relations</h3>
          <p>
            Link each account to the phone they use. When that number messages Tierra Bot, or is mentioned in a
            group, Tierra Bot knows who it is.
          </p>
        </div>
        <span className="zid">Accounts</span>
      </div>
      <article className="card p6" style={{ maxWidth: 760 }}>
        {accounts.length === 0 ? <p className="stamp">Loading accounts</p> : null}
        <div className="rels">
          {accounts.map((account) => {
            const value = drafts[account.id] ?? account.phoneNumber ?? ''
            const pending = pendingId === account.id
            return (
              <div className="rel" key={account.id}>
                <div>
                  <b>{account.name}</b>
                  <div className="stamp">
                    {roleLabel(account.role)} · {account.email}
                  </div>
                </div>
                <div className="field">
                  <label className="sr" htmlFor={`phone-${account.id}`}>
                    Phone for {account.name}
                  </label>
                  <input
                    id={`phone-${account.id}`}
                    type="tel"
                    inputMode="tel"
                    autoComplete="off"
                    placeholder="Phone number"
                    value={value}
                    disabled={!canManage || pending}
                    onChange={(event) =>
                      setDrafts((current) => ({ ...current, [account.id]: event.target.value }))
                    }
                  />
                </div>
                {canManage ? (
                  <div className="actions">
                    <button className="btn-pri" type="button" disabled={pending} onClick={() => void save(account, value)}>
                      Save
                    </button>
                    {account.phoneNumber ? (
                      <button
                        className="btn-sec"
                        type="button"
                        disabled={pending}
                        onClick={() => void save(account, '')}
                      >
                        Remove
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
        {error ? <p className="formerror" style={{ marginTop: 16 }}>{error}</p> : null}
        {canManage ? null : <p className="stamp" style={{ marginTop: 16 }}>An admin can link phone numbers.</p>}
      </article>
    </section>
  )
}

export function SettingsPanel({ canManage }: { canManage: boolean }) {
  const [connection, setConnection] = useState<WhatsappConnection | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  const load = useCallback(async () => {
    const response = await fetch('/api/whatsapp')
    if (!response.ok) return
    const body = (await response.json()) as { connection: WhatsappConnection }
    setConnection(body.connection)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (connection?.status !== 'qr_pending') return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [connection?.status, load])

  async function pair() {
    setPending(true)
    setError('')
    const response = await fetch('/api/whatsapp/pair', { method: 'POST' })
    setPending(false)
    const body = (await response.json().catch(() => null)) as { error?: string; connection?: WhatsappConnection } | null
    if (!response.ok) {
      setError(body?.error ?? 'Could not start pairing')
      return
    }
    if (body?.connection) setConnection(body.connection)
  }

  async function disconnect() {
    setPending(true)
    setError('')
    const response = await fetch('/api/whatsapp/disconnect', { method: 'POST' })
    setPending(false)
    const body = (await response.json().catch(() => null)) as { error?: string; connection?: WhatsappConnection } | null
    if (!response.ok) {
      setError(body?.error ?? 'Could not disconnect')
      return
    }
    if (body?.connection) setConnection(body.connection)
  }

  const qr = connection?.qrBase64
  const image = qr?.startsWith('data:image') ? qr : null

  return (
    <>
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>WhatsApp</h3>
          <p>One company number. Tierra Bot reads personal chats, Message Yourself, and group messages that mention it.</p>
        </div>
        <span className="zid">Zone 1 · Channel</span>
      </div>
      <article className="card p6" style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 640 }}>
        <div className="actions">
          <span className={connection ? pillClass(connection.status) : 'pill grey'}>
            {connection ? statusLabel(connection.status) : 'Loading'}
          </span>
          {connection?.phoneNumber ? <span className="stamp num">{connection.phoneNumber}</span> : null}
        </div>
        {connection?.status === 'connected' ? (
          <p>This number is Tierra Bot. It uses the relations below to recognise who is writing or being mentioned.</p>
        ) : (
          <p>Scan the QR from the phone that should speak for Tierra. Group messages are read when they mention Tierra Bot.</p>
        )}
        {image ? (
          <div className="qr">
            <img src={image} alt="WhatsApp pairing QR code" />
          </div>
        ) : qr ? (
          <p className="stamp">{qr}</p>
        ) : null}
        {error ? <p className="formerror">{error}</p> : null}
        {canManage ? (
          <div className="actions">
            {connection?.status === 'connected' ? (
              <button className="btn-danger" type="button" disabled={pending} onClick={() => void disconnect()}>
                Disconnect
              </button>
            ) : (
              <button className="btn-pri" type="button" disabled={pending} onClick={() => void pair()}>
                {connection?.status === 'qr_pending' ? 'Refresh QR' : 'Connect WhatsApp'}
              </button>
            )}
          </div>
        ) : (
          <p className="stamp">An admin can connect WhatsApp from this page.</p>
        )}
      </article>
    </section>
    <Relations canManage={canManage} />
    </>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import type { WhatsappConnection } from '@/lib/types'

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

export function SettingsPanel({ canConnect }: { canConnect: boolean }) {
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
    <section className="sec">
      <div className="sechead">
        <div>
          <h3>WhatsApp</h3>
          <p>One company number. Personal chats are watched for purchase-order PDFs.</p>
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
          <p>This number is linked. New personal messages with a PDF are read as purchase orders.</p>
        ) : (
          <p>Scan the QR from the phone that should speak for Tierra. Group chats are ignored in this slice.</p>
        )}
        {image ? (
          <div className="qr">
            <img src={image} alt="WhatsApp pairing QR code" />
          </div>
        ) : qr ? (
          <p className="stamp">{qr}</p>
        ) : null}
        {error ? <p className="formerror">{error}</p> : null}
        {canConnect ? (
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
  )
}

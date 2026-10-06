'use client'

import { useEffect, useRef, useState } from 'react'

type AgentMessage = {
  id: string
  role: 'user' | 'tierra'
  text: string
  filename: string | null
  createdAt: string
}

const starters = [
  { label: 'Open orders', text: 'What open orders are on the desk?' },
  { label: 'Stock', text: 'How is stock looking?' },
]

export function AgentChat() {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [readingPdf, setReadingPdf] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void fetch('/api/agent')
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load the conversation')
        return response.json() as Promise<{ messages: AgentMessage[] }>
      })
      .then((body) => {
        if (!cancelled) setMessages(body.messages)
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the conversation')
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, busy])

  async function send(nextText = text, nextFile = file) {
    const trimmed = nextText.trim()
    if (busy || (!trimmed && !nextFile)) return
    setBusy(true)
    setReadingPdf(Boolean(nextFile))
    setError(null)
    const form = new FormData()
    if (trimmed) form.set('text', trimmed)
    if (nextFile) form.set('file', nextFile)
    setText('')
    setFile(null)
    if (fileRef.current) fileRef.current.value = ''
    try {
      const response = await fetch('/api/agent', { method: 'POST', body: form })
      const body = (await response.json()) as {
        error?: string
        message?: AgentMessage
        reply?: AgentMessage | null
      }
      if (!response.ok) {
        setText(trimmed)
        setFile(nextFile)
        setError(body.error ?? 'Tierra Agent could not reply')
        return
      }
      setMessages((current) => [
        ...current,
        ...(body.message ? [body.message] : []),
        ...(body.reply ? [body.reply] : []),
      ])
    } catch {
      setText(trimmed)
      setFile(nextFile)
      setError('Tierra Agent could not reply')
    } finally {
      setBusy(false)
      setReadingPdf(false)
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  const status = busy ? (readingPdf ? 'Reading the purchase order…' : 'Tierra Agent is replying…') : null

  return (
    <div className="agent">
      <div className="agentlog" ref={logRef}>
        {loaded && messages.length === 0 && !busy ? (
          <div className="agentempty">
            <h3>Tierra Agent</h3>
            <p>Ask about orders and stock, or attach a purchase-order PDF. The same desk that answers on WhatsApp answers here.</p>
            <div className="starters">
              {starters.map((starter) => (
                <button key={starter.label} type="button" onClick={() => void send(starter.text, null)}>
                  {starter.label}
                </button>
              ))}
              <button type="button" onClick={() => fileRef.current?.click()}>
                Attach a purchase order
              </button>
            </div>
          </div>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={message.role === 'user' ? 'bubble me' : 'bubble'}>
            <span className="bubblelabel">{message.role === 'user' ? 'You' : 'Tierra Agent'}</span>
            {message.filename ? <div className="pdfchip">{message.filename}</div> : null}
            {message.text ? <p>{message.text}</p> : null}
          </article>
        ))}
      </div>
      <form
        className="agentcompose"
        onSubmit={(event) => {
          event.preventDefault()
          void send()
        }}
      >
        {error ? <div className="formerror">{error}</div> : null}
        {status ? <div className="agentstatus">{status}</div> : null}
        {file ? (
          <div className="pendingfile">
            <span>{file.name}</span>
            <button
              type="button"
              onClick={() => {
                setFile(null)
                if (fileRef.current) fileRef.current.value = ''
              }}
            >
              Remove
            </button>
          </div>
        ) : null}
        <div className="agentrow">
          <textarea
            value={text}
            rows={1}
            placeholder="Ask Tierra Agent, or confirm a short order with YES"
            disabled={busy}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            onChange={(event) => {
              const next = event.target.files?.[0] ?? null
              if (next && next.type !== 'application/pdf' && !next.name.toLowerCase().endsWith('.pdf')) {
                setError('Attach a PDF purchase order')
                event.target.value = ''
                return
              }
              setError(null)
              setFile(next)
            }}
          />
          <button type="button" className="attach" disabled={busy} onClick={() => fileRef.current?.click()}>
            PDF
          </button>
          <button type="submit" className="btn-pri" disabled={busy || (!text.trim() && !file)}>
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

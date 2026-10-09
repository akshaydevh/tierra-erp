'use client'

import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

type AgentMessage = {
  id: string
  role: 'user' | 'tierra'
  text: string
  filename: string | null
  createdAt: string
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  if (href.startsWith('/') && !href.startsWith('//')) return href
  try {
    const url = new URL(href)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.href
  } catch {
    return undefined
  }
  return undefined
}

function MessageText({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          a: ({ href, children }) => {
            const safe = safeHref(href)
            if (!safe) return <span>{children}</span>
            return (
              <a href={safe} target="_blank" rel="noreferrer">
                {children}
              </a>
            )
          },
          img: ({ alt }) => (alt ? <span>{alt}</span> : null),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}

type FileChip = { name: string; href: string }

/**
 * Files the desk attached to a reply: [name](/api/files/<sha>) for SAP files (brackets in the name escaped with a
 * backslash), a bare /api/documents/<id> after the caption for generated PDFs.
 */
const FILE_LINK = /\[((?:\\[\\[\]]|[^\]\\\n]){1,200})\]\((\/api\/(?:files|documents)\/[A-Za-z0-9_-]{1,80})\)/g
const BARE_FILE = /(?<=^|\s)\/api\/(?:files|documents)\/[A-Za-z0-9_-]{1,80}(?=\s|$)/g

/** The message text without its file links, and the files as chips. */
function splitFiles(text: string): { text: string; files: FileChip[] } {
  const files: FileChip[] = []
  const lines = text.split('\n').map((line) => {
    let rest = line.replace(FILE_LINK, (_match, name: string, href: string) => {
      files.push({ name: name.replace(/\\(.)/g, '$1'), href })
      return ''
    })
    const before = files.length
    rest = rest.replace(BARE_FILE, (href) => {
      files.push({ name: href.startsWith('/api/documents/') ? 'Open PDF' : 'Open file', href })
      return ''
    })
    // "TSO/26-27/0001 (version 1): /api/documents/…" loses its dangling colon with the link
    return files.length > before ? rest.replace(/:\s*$/, '').trimEnd() : rest.trimEnd()
  })
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), files }
}

function FileChips({ files }: { files: FileChip[] }) {
  if (files.length === 0) return null
  return (
    <div className="filechips">
      {files.map((file) => (
        <a key={file.href} className="docchip" href={file.href} target="_blank" rel="noreferrer">
          {file.name}
        </a>
      ))}
    </div>
  )
}

type Thread = { messages: AgentMessage[]; pending?: boolean }

/** The desk answers in the background: poll the thread every 1.5 s for up to a minute while a reply is due. */
const POLL_MS = 1500
const POLL_LIMIT_MS = 60_000

async function fetchThread(): Promise<Thread> {
  const response = await fetch('/api/agent', { cache: 'no-store' })
  if (!response.ok) throw new Error('Could not load the conversation')
  return (await response.json()) as Thread
}

const starters = [
  { label: "What's going on", text: 'What is going on in the factory?' },
  { label: 'Free stock', text: 'Which finished goods are short?' },
  { label: 'My tasks', text: 'What are my open tasks?' },
]

export function AgentChat() {
  const [messages, setMessages] = useState<AgentMessage[]>([])
  const [text, setText] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [readingPdf, setReadingPdf] = useState(false)
  /** When the reply being waited for was asked; null when nothing is pending. */
  const [waitingSince, setWaitingSince] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    void fetchThread()
      .then((body) => {
        if (cancelled) return
        setMessages(body.messages)
        if (body.pending) setWaitingSince(Date.now())
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
    if (waitingSince === null) return
    let cancelled = false
    const timer = window.setInterval(() => {
      void fetchThread()
        .then((body) => {
          if (cancelled) return
          setMessages(body.messages)
          if (!body.pending) {
            setWaitingSince(null)
          } else if (Date.now() - waitingSince > POLL_LIMIT_MS) {
            setWaitingSince(null)
            setError('Tierra Agent is taking too long. Ask again in a moment.')
          }
        })
        .catch(() => undefined)
    }, POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [waitingSince])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, busy, waitingSince])

  const waiting = waitingSince !== null

  async function send(nextText = text, nextFile = file) {
    const trimmed = nextText.trim()
    if (busy || waiting || (!trimmed && !nextFile)) return
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
      const body = (await response.json()) as { error?: string; message?: AgentMessage }
      if (!response.ok) {
        setText(trimmed)
        setFile(nextFile)
        setError(body.error ?? 'Tierra Agent could not reply')
        return
      }
      setMessages((current) => [...current, ...(body.message ? [body.message] : [])])
      setWaitingSince(Date.now())
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

  const status = busy
    ? readingPdf
      ? 'Sending the purchase order…'
      : 'Sending…'
    : waiting
      ? 'Tierra Agent is working…'
      : null

  return (
    <div className="agent">
      <div className="agentlog" ref={logRef}>
        {loaded && messages.length === 0 && !busy && !waiting ? (
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
        {messages.map((message) => {
          const { text: body, files } = message.role === 'tierra' ? splitFiles(message.text) : { text: message.text, files: [] }
          return (
            <article key={message.id} className={message.role === 'user' ? 'bubble me' : 'bubble'}>
              <span className="bubblelabel">{message.role === 'user' ? 'You' : 'Tierra Agent'}</span>
              {message.filename ? <div className="pdfchip">{message.filename}</div> : null}
              {body ? <MessageText text={body} /> : null}
              <FileChips files={files} />
            </article>
          )
        })}
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
            placeholder="Ask about an order, invoice, stock or a production order"
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
          <button type="submit" className="btn-pri" disabled={busy || waiting || (!text.trim() && !file)}>
            Send
          </button>
        </div>
      </form>
    </div>
  )
}

import { randomUUID } from 'node:crypto'
import type { PublicUser } from '../db/types'
import type { ThreadMessage } from '../db/store'
import { incomingJob } from '../jobs/worker'
import type { IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { deskThreadJid } from './outbox'
import { isTierraReply, tierraReplyText } from './send'

export const PDF_BYTE_LIMIT = 8 * 1024 * 1024
/** How long the desk shows "working" for a turn without a reply; the loop's budget is 40 s. */
export const DESK_PENDING_MS = 60_000

export type AgentMessage = {
  id: string
  role: 'user' | 'tierra'
  text: string
  filename: string | null
  createdAt: string
}

export type DeskPdf = {
  filename: string
  content: Buffer
}

export type DeskPostResult =
  | { ok: true; message: AgentMessage }
  | { ok: false; status: 400 | 409 | 503; error: string }

function toAgentMessage(row: ThreadMessage): AgentMessage {
  const raw = row.body ?? ''
  const tierra = isTierraReply(raw)
  return {
    id: row.id,
    role: tierra ? 'tierra' : 'user',
    text: tierra ? tierraReplyText(raw) : raw,
    filename: row.filename,
    createdAt: row.createdAt,
  }
}

/**
 * The desk thread, and whether the person's last message still waits for its reply: its turn has not finished (the
 * worker stamps it answered when the reply is in, or when the turn failed) and it was sent less than a minute ago.
 * Other posts landing in the thread meanwhile (a PO summary, an approval request) do not end the wait.
 */
export async function listDeskMessages(
  deps: AgentDeps,
  userId: string,
): Promise<{ messages: AgentMessage[]; pending: boolean }> {
  const rows = await deps.store.listThread(deskThreadJid(userId))
  const messages = rows.map(toAgentMessage)
  const lastTurn = [...rows].reverse().find((row) => !isTierraReply(row.body ?? ''))
  const pending = Boolean(
    lastTurn && !lastTurn.answeredAt && deps.now().getTime() - Date.parse(lastTurn.createdAt) < DESK_PENDING_MS,
  )
  return { messages, pending }
}

/**
 * Stores the desk message (and its PDF) and queues the turn like a WhatsApp message; the reply lands in the thread
 * when the worker has answered, and the desk polls for it.
 */
export async function postDeskTurn(
  deps: AgentDeps,
  user: PublicUser,
  input: { text: string; pdf: DeskPdf | null },
): Promise<DeskPostResult> {
  const text = input.text.trim()
  const pdf = input.pdf
  if (!text && !pdf) return { ok: false, status: 400, error: 'Write a message or attach a PDF' }
  if (pdf && pdf.content.length > PDF_BYTE_LIMIT) {
    return { ok: false, status: 400, error: 'That PDF is larger than 8MB' }
  }
  if (pdf && pdf.content.length === 0) {
    return { ok: false, status: 400, error: 'That PDF is empty' }
  }

  const id = `desk-in-${randomUUID()}`
  const remoteJid = deskThreadJid(user.id)
  const claimed = await deps.store.claimMessage({
    evolutionMessageId: id,
    remoteJid,
    fromMe: true,
    hasPdf: Boolean(pdf),
    body: text || null,
    kind: pdf ? 'document' : 'text',
  })
  if (!claimed) return { ok: false, status: 409, error: 'That message was already sent' }
  const documentId = pdf
    ? await deps.store.insertDocument({ filename: pdf.filename, mimeType: 'application/pdf', content: pdf.content, messageId: id })
    : null

  const message: IncomingMessage = {
    id,
    remoteJid,
    fromMe: true,
    text: text || null,
    quotedText: null,
    quotedId: null,
    quotedParticipant: null,
    mentionedJids: [],
    participantJid: null,
    participantAltJid: null,
    aliasJid: null,
    control: false,
    kind: pdf ? 'document' : 'text',
    reaction: null,
    pdf: pdf ? { fileName: pdf.filename, mimeType: 'application/pdf' } : null,
    raw: null,
    embeddedBase64: null,
  }
  const job = incomingJob(message, 'self')
  const queued = await deps.enqueue({ ...job, payload: { ...job.payload, desk: { userId: user.id, documentId } } })
  if (!queued) return { ok: false, status: 503, error: 'Tierra Agent could not take that message. Try again.' }

  const stored = (await deps.store.listThread(remoteJid)).find((row) => row.id === id)
  return {
    ok: true,
    message: stored
      ? toAgentMessage(stored)
      : { id, role: 'user', text, filename: pdf?.filename ?? null, createdAt: new Date().toISOString() },
  }
}

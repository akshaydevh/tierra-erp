import { randomUUID } from 'node:crypto'
import type { PublicUser } from '../db/types'
import type { ThreadMessage } from '../db/store'
import type { IncomingMessage } from '../whatsapp/parse'
import type { Person } from '../whatsapp/people'
import {
  deskThreadJid,
  handleIncoming,
  isTierraReply,
  tierraReplyText,
  type AgentDeps,
} from './handle-message'

export const PDF_BYTE_LIMIT = 8 * 1024 * 1024

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
  | { ok: true; message: AgentMessage; reply: AgentMessage | null }
  | { ok: false; status: 400 | 409; error: string }

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

export async function listDeskMessages(deps: AgentDeps, userId: string): Promise<AgentMessage[]> {
  const rows = await deps.store.listThread(deskThreadJid(userId))
  return rows.map(toAgentMessage)
}

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
  })
  if (!claimed) return { ok: false, status: 409, error: 'That message was already sent' }

  const accounts = await deps.store.listAccountLinks()
  const link = accounts.find((account) => account.id === user.id)
  const speaker: Person = {
    userId: user.id,
    name: user.name,
    role: user.role,
    phoneNumber: link?.phoneNumber ?? '',
  }
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
    embeddedBase64: pdf ? pdf.content.toString('base64') : null,
  }
  const replyBody = await handleIncoming(deps, message, 'self', { speaker })
  const thread = await deps.store.listThread(remoteJid)
  const stored = thread.find((row) => row.id === id)
  const replyRow = replyBody ? [...thread].reverse().find((row) => row.body === replyBody) : undefined
  return {
    ok: true,
    message: stored
      ? toAgentMessage(stored)
      : {
          id,
          role: 'user',
          text,
          filename: pdf?.filename ?? null,
          createdAt: new Date().toISOString(),
        },
    reply: replyRow ? toAgentMessage(replyRow) : null,
  }
}

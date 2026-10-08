import type { MessageKind } from '../db/types'
import { isBotEcho } from './brand'
import { chatNumber, phoneDigits, phoneFromPayload, qrFromPayload } from './qr'

export type PdfAttachment = {
  fileName: string
  mimeType: string
}

export type Reaction = {
  targetId: string
  /** An empty emoji means the reaction was removed. */
  emoji: string
  targetFromMe: boolean | null
  targetRemoteJid: string | null
}

export type IncomingMessage = {
  id: string
  remoteJid: string
  fromMe: boolean
  text: string | null
  quotedText: string | null
  quotedId: string | null
  quotedParticipant: string | null
  mentionedJids: string[]
  participantJid: string | null
  participantAltJid: string | null
  aliasJid: string | null
  control: boolean
  kind: MessageKind
  reaction: Reaction | null
  pdf: PdfAttachment | null
  raw: unknown
  embeddedBase64: string | null
}

export type ChatKind = 'self' | 'personal' | 'group'

export type BotMode = 'personal' | 'dedicated'

export type AudienceOptions = {
  /** The message reacts to or quotes a message the bot sent. */
  targetsBot?: boolean
  botMode?: BotMode
}

export type WebhookEvent =
  | { type: 'qr'; qr: string | null }
  | { type: 'connection'; state: string; phone: string | null }
  | { type: 'message'; message: IncomingMessage }
  | { type: 'ignore' }

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function isPersonalJid(jid: string): boolean {
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us') || jid.endsWith('@broadcast')) {
    return false
  }
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid') || jid.endsWith('@c.us')
}

function isControlMessage(container: Record<string, unknown>): boolean {
  const message = record(container.message)
  if (!message) return false
  return Boolean(message.protocolMessage || message.pollUpdateMessage)
}

function readReaction(container: Record<string, unknown>): Reaction | null {
  const reaction = record(record(container.message)?.reactionMessage)
  if (!reaction) return null
  const key = record(reaction.key)
  const targetId = stringOf(key?.id)
  if (!targetId) return null
  return {
    targetId,
    emoji: typeof reaction.text === 'string' ? reaction.text : '',
    targetFromMe: typeof key?.fromMe === 'boolean' ? key.fromMe : null,
    targetRemoteJid: stringOf(key?.remoteJid),
  }
}

function findDocument(message: Record<string, unknown>): Record<string, unknown> | null {
  const direct = record(message.documentMessage)
  if (direct) return direct
  const caption = record(message.documentWithCaptionMessage)
  const nested = caption ? record(caption.message) : null
  const inner = nested ? record(nested.documentMessage) : null
  return inner
}

function readPdf(container: Record<string, unknown> | null): PdfAttachment | null {
  if (!container) return null
  const message = record(container.message)
  if (!message) return null
  const doc = findDocument(message)
  if (!doc) return null
  const mime = stringOf(doc.mimetype) ?? stringOf(doc.mimeType) ?? ''
  const fileName = stringOf(doc.fileName) ?? stringOf(doc.filename) ?? stringOf(doc.title) ?? 'document.pdf'
  if (mime !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) return null
  return { fileName, mimeType: mime || 'application/pdf' }
}

function contextInfos(container: Record<string, unknown>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const push = (value: unknown) => {
    const info = record(value)
    if (info) found.push(info)
  }
  push(container.contextInfo)
  const message = record(container.message)
  if (!message) return found
  push(message.contextInfo)
  push(record(message.extendedTextMessage)?.contextInfo)
  push(findDocument(message)?.contextInfo)
  push(record(message.imageMessage)?.contextInfo)
  push(record(message.videoMessage)?.contextInfo)
  push(record(message.documentWithCaptionMessage)?.contextInfo)
  return found
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string' && value.length > 0) return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

function quotedBody(quoted: Record<string, unknown>): string | null {
  return (
    stringOf(quoted.conversation) ??
    stringOf(record(quoted.extendedTextMessage)?.text) ??
    stringOf(record(quoted.imageMessage)?.caption) ??
    stringOf(findDocument(quoted)?.caption) ??
    null
  )
}

function readQuotedText(container: Record<string, unknown>): string | null {
  for (const info of contextInfos(container)) {
    const quoted = record(info.quotedMessage)
    const text = quoted ? quotedBody(quoted) : null
    if (text) return text
  }
  return null
}

function readQuote(container: Record<string, unknown>): { id: string | null; participant: string | null } {
  for (const info of contextInfos(container)) {
    const id = stringOf(info.stanzaId)
    if (id) return { id, participant: stringOf(info.participant) }
  }
  return { id: null, participant: null }
}

function readMentions(container: Record<string, unknown>): string[] {
  const mentions = new Set<string>()
  for (const info of contextInfos(container)) {
    for (const jid of stringList(info.mentionedJid)) mentions.add(jid)
  }
  return [...mentions]
}

function readText(container: Record<string, unknown>): string | null {
  const message = record(container.message)
  if (!message) return null
  const doc = findDocument(message)
  return (
    stringOf(message.conversation) ??
    stringOf(record(message.extendedTextMessage)?.text) ??
    stringOf(doc?.caption) ??
    stringOf(record(message.imageMessage)?.caption) ??
    null
  )
}

function readKind(container: Record<string, unknown>, text: string | null): MessageKind {
  const message = record(container.message)
  if (!message) return 'other'
  if (message.reactionMessage) return 'reaction'
  if (findDocument(message)) return 'document'
  if (message.imageMessage) return 'image'
  return text ? 'text' : 'other'
}

function embeddedBase64(container: Record<string, unknown>): string | null {
  const direct = stringOf(container.base64)
  if (direct) return direct
  const message = record(container.message)
  return message ? stringOf(message.base64) : null
}

const MEDIA_KEYS = new Set(['base64', 'jpegThumbnail'])

function stripMedia(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripMedia)
  const row = record(value)
  if (!row) return value
  return Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => !MEDIA_KEYS.has(key))
      .map(([key, item]) => [key, stripMedia(item)]),
  )
}

/** The message without embedded file bytes or thumbnails, for queueing. The PDF is downloaded again when needed. */
export function withoutMedia(message: IncomingMessage): IncomingMessage {
  return { ...message, embeddedBase64: null, raw: stripMedia(message.raw) }
}

function firstMessage(data: unknown): Record<string, unknown> | null {
  const row = record(data)
  if (row?.key) return row
  if (row && Array.isArray(row.messages)) return record(row.messages[0])
  if (Array.isArray(data)) return record(data[0])
  return row
}

export function parseWebhook(body: unknown): WebhookEvent {
  const root = record(body)
  if (!root) return { type: 'ignore' }
  const instance = stringOf(root.instance)
  if (instance && instance !== 'tierra') return { type: 'ignore' }
  const event = String(root.event ?? '')
    .toLowerCase()
    .replace(/_/g, '.')
  const data = root.data

  if (event.includes('qrcode')) {
    return { type: 'qr', qr: qrFromPayload(data) }
  }

  if (event.includes('connection')) {
    const payload = record(data) ?? {}
    return {
      type: 'connection',
      state: stringOf(payload.state) ?? stringOf(payload.status) ?? 'close',
      phone: phoneFromPayload(data),
    }
  }

  if (event !== 'messages.upsert') return { type: 'ignore' }
  const message = firstMessage(data)
  if (!message) return { type: 'ignore' }
  const key = record(message.key)
  const id = stringOf(key?.id)
  const remoteJid = stringOf(key?.remoteJid)
  if (!id || !remoteJid) return { type: 'ignore' }
  const text = readText(message)
  const quote = readQuote(message)
  return {
    type: 'message',
    message: {
      id,
      remoteJid,
      fromMe: key?.fromMe === true,
      text,
      quotedText: readQuotedText(message),
      quotedId: quote.id,
      quotedParticipant: quote.participant,
      mentionedJids: readMentions(message),
      participantJid: stringOf(key?.participant) ?? stringOf(message.participant),
      participantAltJid: stringOf(key?.participantAlt) ?? stringOf(message.participantAlt),
      aliasJid: stringOf(key?.remoteJidAlt),
      control: isControlMessage(message),
      kind: readKind(message, text),
      reaction: readReaction(message),
      pdf: readPdf(message),
      raw: message,
      embeddedBase64: embeddedBase64(message),
    },
  }
}

export function replyNumber(jid: string): string {
  return chatNumber(jid)
}

export { phoneDigits }

export function isGroupJid(jid: string): boolean {
  return jid.endsWith('@g.us')
}

function sameOwner(phoneNumber: string | null, jid: string): boolean {
  const own = phoneDigits(phoneNumber)
  const chat = phoneDigits(jid)
  if (own.length < 8 || chat.length < 8) return false
  if (own === chat) return true
  const [longer, shorter] = own.length >= chat.length ? [own, chat] : [chat, own]
  const extra = longer.length - shorter.length
  return longer.startsWith(shorter) && extra > 0 && extra <= 2
}

function exactOwner(phoneNumber: string | null, jid: string): boolean {
  const own = phoneDigits(phoneNumber)
  return own.length >= 8 && phoneDigits(jid) === own
}

const BOT_NAME = /tierra\s+bot/i

export function mentionsTierraBot(message: IncomingMessage, phoneNumber: string | null): boolean {
  const text = message.text ?? ''
  if (BOT_NAME.test(text)) return true
  const phone = phoneDigits(phoneNumber)
  if (phone.length < 8) return false
  if (message.mentionedJids.some((jid) => phoneDigits(jid) === phone)) return true
  return new RegExp(`@\\+?${phone}(?!\\d)`).test(text)
}

const READ_RECEIPT_EMOJI = '👀'

function isEcho(message: IncomingMessage, botMode: BotMode): boolean {
  if (!message.fromMe) return false
  if (botMode === 'dedicated') return true
  if (isBotEcho(message.text)) return true
  return message.reaction?.emoji === READ_RECEIPT_EMOJI
}

export function audienceFor(
  message: IncomingMessage,
  phoneNumber: string | null,
  options: AudienceOptions = {},
): ChatKind | 'ignore' {
  const targetsBot = options.targetsBot ?? false
  if (message.control || isEcho(message, options.botMode ?? 'personal')) return 'ignore'
  if (message.reaction && !targetsBot) return 'ignore'
  if (isGroupJid(message.remoteJid)) {
    return targetsBot || mentionsTierraBot(message, phoneNumber) ? 'group' : 'ignore'
  }
  const personal =
    isPersonalJid(message.remoteJid) || (message.aliasJid ? isPersonalJid(message.aliasJid) : false)
  if (!personal) return 'ignore'
  const jids = [message.remoteJid, message.aliasJid]
  const isExactSelf = jids.some((jid) => jid && isPersonalJid(jid) && exactOwner(phoneNumber, jid))
  const isSelf =
    isExactSelf ||
    (message.fromMe && jids.some((jid) => jid && isPersonalJid(jid) && sameOwner(phoneNumber, jid)))
  if (isSelf) return 'self'
  if (message.fromMe) return 'ignore'
  return 'personal'
}

export function deliveryAddress(remoteJid: string): string {
  if (isGroupJid(remoteJid) || remoteJid.endsWith('@lid')) return remoteJid
  return replyNumber(remoteJid)
}

export function replyChatJid(message: IncomingMessage): string {
  const jids = [message.aliasJid, message.remoteJid].filter((jid): jid is string => Boolean(jid))
  return jids.find((jid) => jid.endsWith('@s.whatsapp.net')) ?? message.remoteJid
}

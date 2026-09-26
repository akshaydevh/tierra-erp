import { chatNumber, phoneFromPayload, qrFromPayload } from './qr'

export type PdfAttachment = {
  fileName: string
  mimeType: string
}

export type IncomingMessage = {
  id: string
  remoteJid: string
  fromMe: boolean
  text: string | null
  pdf: PdfAttachment | null
  raw: unknown
  embeddedBase64: string | null
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
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')
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

function readText(container: Record<string, unknown>): string | null {
  const message = record(container.message)
  if (!message) return null
  return (
    stringOf(message.conversation) ??
    stringOf(record(message.extendedTextMessage)?.text) ??
    null
  )
}

function embeddedBase64(container: Record<string, unknown>): string | null {
  const direct = stringOf(container.base64)
  if (direct) return direct
  const message = record(container.message)
  return message ? stringOf(message.base64) : null
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
  return {
    type: 'message',
    message: {
      id,
      remoteJid,
      fromMe: key?.fromMe === true,
      text: readText(message),
      pdf: readPdf(message),
      raw: message,
      embeddedBase64: embeddedBase64(message),
    },
  }
}

export function replyNumber(jid: string): string {
  return chatNumber(jid)
}

import type { Effect, ToolContext } from './tools'
import { recordAccess } from './tools/types'
import {
  docKey,
  documentByKey,
  filesForDocument,
  parseDocKey,
  primaryFile,
  type DocKey,
  type DocumentHeader,
  type FileLink,
} from '../queries/documents'
import { isNotImported } from '../queries/meta'
import { deliveryAddress, replyChatJid, type IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { isDeskThread, postToDesk, sendBotText } from './outbox'
import { PIN_TTL_MS, chatJids, freshPin } from './pins'
import type { Ref } from './refs'
import { ensureTierraPrefix } from './send'

/**
 * SAP attachment files in the chat (plan §3.4, goal 2): what send_document queues, the attachment rule that adds
 * the main file when an answer is about one or two specific documents, and the delivery after the reply.
 */

/** WhatsApp gets raw bytes only up to this size; bigger files need a presigned URL (FILE_STORE=s3). */
export const BASE64_LIMIT = 5 * 1024 * 1024
export const FILE_PURPOSE = 'sap_file'
export const DOCUMENT_SUBJECT = 'sap_document'

const ROLE_LABELS: Record<string, string> = {
  invoice_pdf: 'Invoice',
  ewaybill: 'E-way bill',
  einvoice_qr: 'E-invoice QR',
  credit_note_pdf: 'Credit note',
  debit_note_pdf: 'Debit note',
  ap_invoice_pdf: 'A/P invoice print',
  po_pdf: 'Purchase order',
  so_pdf: 'Sales order',
  receipt_pdf: 'Receipt voucher',
  supporting: 'Attachment',
}

export function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ')
}

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 })

/** "TF/26-27/101 · Alpha Snacks · ₹1,05,000 · PO APO-7001"; other files name their kind after the number. */
export function fileCaption(doc: Pick<DocumentHeader, 'docNo' | 'cardName' | 'total' | 'customerPoNo'>, file: Pick<FileLink, 'role'>): string {
  const main = file.role === 'invoice_pdf' || file.role === 'credit_note_pdf'
  return [
    doc.docNo,
    main ? null : roleLabel(file.role),
    doc.cardName,
    doc.total != null ? `₹${inr.format(doc.total)}` : null,
    doc.customerPoNo ? `PO ${doc.customerPoNo}` : null,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' · ')
}

/** A file as the model sees it: no storage key, no hash beyond a short id. */
export function fileForModel(file: FileLink) {
  return {
    role: file.role,
    kind: roleLabel(file.role),
    fileName: file.fileName,
    sizeKb: Math.max(1, Math.round(file.sizeBytes / 1024)),
  }
}

export function queuedFor(effects: Effect[], doc: DocKey): boolean {
  return effects.some((effect) => effect.kind === 'send_file' && effect.doc.sapObject === doc.sapObject && effect.doc.docEntry === doc.docEntry)
}

/** Queues one file for the chat (once per file per turn). */
export function queueFile(ctx: ToolContext, doc: DocumentHeader, file: FileLink): void {
  const already = ctx.effects.some((effect) => effect.kind === 'send_file' && effect.file.sha256 === file.sha256)
  if (already) return
  ctx.effects.push({
    kind: 'send_file',
    file,
    doc: { sapObject: doc.sapObject, docEntry: doc.docEntry, docNo: doc.docNo },
    caption: fileCaption(doc, file),
  })
}

/** SAP documents the attachment rule applies to: A/R invoices and credit notes, A/P invoices, GRNs. */
const ATTACHABLE = new Set(['13', '14', '18', '20'])
const NO_FILE = /no file on record/i

export function noFileLine(docNo: string): string {
  return `SAP has no file on record for ${docNo}.`
}

/**
 * The attachment rule (plan §3.4), after an answered turn: when the answer concerns one or two specific documents
 * (named in the message, or looked up one at a time by the model), each A/R invoice, credit note, GRN or A/P invoice
 * among them gets its main file, unless send_document already handled it (sent, or said why not). A document
 * without any file gets the line "SAP has no file on record for …". A TSO named in the message gets its PDF (Tierra
 * people only). Lists never attach.
 */
export async function applyAttachmentRule(
  deps: AgentDeps,
  ctx: ToolContext,
  refs: Ref[],
): Promise<string[]> {
  const concerned = new Map<string, DocKey & { docNo: string }>()
  for (const ref of refs) {
    if (ref.kind === 'document' && ref.found) {
      concerned.set(docKey(ref.found), { sapObject: ref.found.sapObject, docEntry: ref.found.docEntry, docNo: ref.found.docNo })
    }
  }
  for (const doc of ctx.concerned ?? []) concerned.set(docKey(doc), doc)
  const tsos = refs.filter((ref): ref is Extract<Ref, { kind: 'tso' }> => ref.kind === 'tso' && Boolean(ref.order))
  if (concerned.size + tsos.length === 0 || concerned.size + tsos.length > 2) return []

  const notes: string[] = []
  for (const doc of concerned.values()) {
    if (!ATTACHABLE.has(doc.sapObject) || queuedFor(ctx.effects, doc) || ctx.sendTried?.includes(docKey(doc))) continue
    try {
      const header = await documentByKey(deps.sapSql, ctx.cards, doc)
      if (!header) continue
      const file = primaryFile(doc.sapObject, await filesForDocument(deps.sapSql, ctx.cards, doc, recordAccess(ctx)))
      if (file) queueFile(ctx, header, file)
      else notes.push(noFileLine(header.docNo))
    } catch (error) {
      if (!isNotImported(error)) throw error
    }
  }
  if (ctx.audience.kind === 'internal') {
    for (const ref of tsos) {
      const id = ref.order?.id
      if (!id || ctx.effects.some((effect) => effect.kind === 'send_so_pdf' && effect.salesOrderId === id)) continue
      ctx.effects.push({ kind: 'send_so_pdf', salesOrderId: id, annex: false })
    }
  }
  return notes
}

/** Adds the "no file" lines to an answer that does not say so already. */
export function withNotes(text: string, notes: string[]): string {
  if (notes.length === 0 || NO_FILE.test(text)) return text
  return [text, ...notes].join('\n\n')
}

/** Link text in markdown: backslash-escape what would end it (SAP names carry "[Approved]"). */
export function markdownText(value: string): string {
  return value.replace(/[\\[\]]/g, (char) => `\\${char}`).replace(/\n/g, ' ')
}

const STRONG_PINS = new Set(['approval', 'sales_order', 'customer_po', 'task'])

/**
 * The SAP document whose file this chat saw last: a fresh `sap_document` pin (a quoted file message or the last
 * send), else the newest file the bot sent here in the pin's lifetime.
 */
export async function lastDocumentFor(
  deps: Pick<AgentDeps, 'store' | 'now'>,
  message: Pick<IncomingMessage, 'remoteJid' | 'aliasJid'>,
): Promise<(DocKey & { role?: string }) | null> {
  const pin = await freshPin(deps, message)
  if (pin?.subjectType === DOCUMENT_SUBJECT) return parseDocKey(pin.subjectId)
  const recent = await deps.store.listRecentMessages(chatJids(message), 24)
  const lastFile = [...recent].reverse().find((row) => row.fromMe && row.purpose === FILE_PURPOSE)
  if (!lastFile) return null
  const stored = await deps.store.findMessage(lastFile.id)
  if (stored?.subjectType !== DOCUMENT_SUBJECT || !stored.subjectId) return null
  if (deps.now().getTime() - Date.parse(stored.createdAt) > PIN_TTL_MS) return null
  return parseDocKey(stored.subjectId)
}

/** Pins the chat to the document just sent, unless a workflow (an approval, a TSO, a task) holds the pin. */
async function pinDocument(deps: AgentDeps, message: IncomingMessage, chat: string, key: string): Promise<void> {
  const current = await freshPin(deps, message)
  if (current && STRONG_PINS.has(current.subjectType)) return
  await deps.store.setChatContext(chat, DOCUMENT_SUBJECT, key)
}

/**
 * Delivers one queued file after the reply. WhatsApp: sendMedia with a presigned URL (s3), else the bytes as base64
 * up to 5 MB; images go as images (the QR), everything else as a document. Registered as an outbound message whose
 * subject is the document, so a quote of it pins the chat to that document. The desk gets a link to /api/files/.
 */
export async function deliverFile(deps: AgentDeps, message: IncomingMessage, effect: Extract<Effect, { kind: 'send_file' }>): Promise<void> {
  const chat = replyChatJid(message)
  // the subject names the file's role too, so "send that again" resends this very file
  const key = `${docKey(effect.doc)}:${effect.file.role}`
  const { file } = effect
  if (isDeskThread(chat)) {
    await postToDesk(
      deps.store,
      chat,
      ensureTierraPrefix(`${effect.caption}\n\n[${markdownText(file.fileName)}](/api/files/${file.sha256})`),
      { subjectType: DOCUMENT_SUBJECT, subjectId: key },
      FILE_PURPOSE,
    )
    await pinDocument(deps, message, chat, key)
    return
  }
  const store = deps.files
  if (!store) {
    await sendBotText(deps, message, `${file.fileName} is on record for ${effect.doc.docNo}, but file storage is not set up on this server.`)
    return
  }
  const caption = ensureTierraPrefix(effect.caption)
  const media = {
    number: deliveryAddress(chat),
    mediatype: file.mime.startsWith('image/') ? ('image' as const) : ('document' as const),
    mimetype: file.mime,
    fileName: file.fileName,
    caption,
  }
  const asBase64 = async (): Promise<string | null> => {
    if (file.sizeBytes > BASE64_LIMIT) return null
    const bytes = await store.get(file.storageKey)
    return bytes ? bytes.toString('base64') : null
  }
  let sent: { messageId: string | null } | null = null
  if (store.presignedUrl) {
    try {
      sent = await deps.evolution.sendMedia({ ...media, media: await store.presignedUrl(file.storageKey, { fileName: file.fileName, mime: file.mime }) })
    } catch (error) {
      console.error('Sending a file by URL failed; trying the bytes', error)
    }
  }
  if (!sent) {
    const base64 = await asBase64()
    if (!base64) {
      const why =
        file.sizeBytes > BASE64_LIMIT
          ? `is ${(file.sizeBytes / 1024 / 1024).toFixed(1)} MB, too large to send from here; open it on the Tierra dashboard`
          : 'is on record but missing from file storage'
      await sendBotText(deps, message, `${file.fileName} (${effect.doc.docNo}) ${why}.`)
      return
    }
    sent = await deps.evolution.sendMedia({ ...media, media: base64 })
  }
  if (sent.messageId) {
    await deps.store.claimMessage({
      evolutionMessageId: sent.messageId,
      remoteJid: chat,
      fromMe: true,
      hasPdf: file.mime === 'application/pdf',
      body: caption,
      kind: media.mediatype,
      purpose: FILE_PURPOSE,
      subjectType: DOCUMENT_SUBJECT,
      subjectId: key,
      status: 'sent',
    })
  }
  await pinDocument(deps, message, chat, key)
}

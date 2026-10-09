import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../db/memory'
import { FsFileStore, type FileStore } from '../files/store'
import type { FileLink } from '../queries/documents'
import { primaryFile } from '../queries/documents'
import type { EvolutionClient, MediaMessage } from '../whatsapp/evolution'
import type { IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { BASE64_LIMIT, applyAttachmentRule, deliverFile, fileCaption, lastDocumentFor, markdownText, withNotes } from './files'
import type { Ref } from './refs'
import type { ToolContext } from './tools'
import type { Effect } from './tools'

function file(role: string, over: Partial<FileLink> = {}): FileLink {
  const sha = (over.sha256 ?? role.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a')).slice(0, 64)
  return {
    sha256: sha,
    role,
    fileName: `${role}.pdf`,
    mime: 'application/pdf',
    sizeBytes: 10,
    kind: 'attachment',
    storageKey: `sap/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.pdf`,
    linkMethod: 'atc1',
    fileTime: '2026-03-31T10:00:00Z',
    ...over,
  }
}

describe('which file a document sends', () => {
  it('prefers an invoice print (newest), then the e-way bill, then the QR', () => {
    const older = file('invoice_pdf', { sha256: 'a'.repeat(64), fileTime: '2026-03-01T00:00:00Z' })
    const newer = file('invoice_pdf', { sha256: 'b'.repeat(64), fileTime: '2026-03-02T00:00:00Z' })
    const ewb = file('ewaybill', { sha256: 'c'.repeat(64) })
    const qr = file('einvoice_qr', { sha256: 'd'.repeat(64), mime: 'image/png' })
    expect(primaryFile('13', [qr, ewb, older, newer])).toBe(newer)
    expect(primaryFile('13', [qr, ewb])).toBe(ewb)
    expect(primaryFile('13', [qr])).toBe(qr)
    expect(primaryFile('13', [file('supporting')])).toBeNull()
    expect(primaryFile('20', [file('supporting', { sha256: 'e'.repeat(64) })])?.role).toBe('supporting')
    expect(primaryFile('18', [])).toBeNull()
    expect(primaryFile('17', [file('so_pdf')])?.role).toBe('so_pdf')
  })

  it('captions the main file with number, party, value and PO; other files name their kind', () => {
    const doc = { docNo: 'TF/25-26/3', cardName: 'Alpha Snacks Pvt Ltd', total: 105000, customerPoNo: 'APO-7001' }
    expect(fileCaption(doc, { role: 'invoice_pdf' })).toBe('TF/25-26/3 · Alpha Snacks Pvt Ltd · ₹1,05,000 · PO APO-7001')
    expect(fileCaption({ ...doc, customerPoNo: null }, { role: 'ewaybill' })).toBe('TF/25-26/3 · E-way bill · Alpha Snacks Pvt Ltd · ₹1,05,000')
  })

  it('adds "no file" lines once and escapes link text', () => {
    expect(withNotes('Here it is.', ['SAP has no file on record for GR/25-26/1.'])).toBe('Here it is.\n\nSAP has no file on record for GR/25-26/1.')
    expect(withNotes('SAP has no file on record for GR/25-26/1.', ['SAP has no file on record for GR/25-26/1.'])).toBe(
      'SAP has no file on record for GR/25-26/1.',
    )
    expect(markdownText('AR Invoice [Approved]_1.pdf')).toBe('AR Invoice \\[Approved\\]_1.pdf')
  })
})

describe('delivering a file to WhatsApp', () => {
  let dir: string
  let fsStore: FsFileStore
  let store: MemoryStore
  let media: MediaMessage[]
  let texts: string[]
  let deps: AgentDeps

  const message = (remoteJid = '919900000000@s.whatsapp.net'): IncomingMessage => ({
    id: `in-${Math.random()}`,
    remoteJid,
    fromMe: false,
    text: 'send it',
    quotedText: null,
    quotedId: null,
    quotedParticipant: null,
    mentionedJids: [],
    participantJid: null,
    participantAltJid: null,
    aliasJid: null,
    control: false,
    kind: 'text',
    reaction: null,
    pdf: null,
    raw: null,
    embeddedBase64: null,
  })

  const effect = (link: FileLink): Extract<Effect, { kind: 'send_file' }> => ({
    kind: 'send_file',
    file: link,
    doc: { sapObject: '13', docEntry: 204, docNo: 'TF/25-26/3' },
    caption: 'TF/25-26/3 · Alpha Snacks Pvt Ltd · ₹1,050',
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tierra-deliver-'))
    fsStore = new FsFileStore(dir)
    store = new MemoryStore('x')
    media = []
    texts = []
    const evolution = {
      sendText: async (_number: string, text: string) => {
        texts.push(text)
        return { messageId: `t-${texts.length}` }
      },
      sendMedia: async (sent: MediaMessage) => {
        media.push(sent)
        return { messageId: `m-${media.length}` }
      },
    } as unknown as EvolutionClient
    deps = { store, evolution, files: fsStore, now: () => new Date() } as unknown as AgentDeps
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('sends a PDF as a document (base64), registers it and pins the chat to the document', async () => {
    const link = file('invoice_pdf', { sha256: '1'.repeat(64) })
    await fsStore.put(link.storageKey, Buffer.from('%PDF-1.4 alpha'))
    await deliverFile(deps, message(), effect(link))
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ number: '919900000000', mediatype: 'document', mimetype: 'application/pdf', fileName: 'invoice_pdf.pdf' })
    expect(Buffer.from(media[0]!.media, 'base64').toString()).toBe('%PDF-1.4 alpha')
    expect(media[0]!.caption).toContain('TF/25-26/3 · Alpha Snacks Pvt Ltd')
    expect(await store.findMessage('m-1')).toMatchObject({ kind: 'document', purpose: 'sap_file', subjectType: 'sap_document', subjectId: '13:204:invoice_pdf' })
    expect(await store.getChatContext('919900000000@s.whatsapp.net')).toMatchObject({ subjectType: 'sap_document', subjectId: '13:204:invoice_pdf' })
    expect(await lastDocumentFor(deps, message())).toEqual({ sapObject: '13', docEntry: 204, role: 'invoice_pdf' })
  })

  it('sends a QR png as an image and keeps an approval pin', async () => {
    await store.setChatContext('919900000000@s.whatsapp.net', 'approval', 'apr_1')
    const link = file('einvoice_qr', { sha256: '2'.repeat(64), mime: 'image/png', fileName: 'GSTZENQRx.png' })
    await fsStore.put(link.storageKey, Buffer.from('png'))
    await deliverFile(deps, message(), effect(link))
    expect(media[0]).toMatchObject({ mediatype: 'image', mimetype: 'image/png' })
    expect(await store.getChatContext('919900000000@s.whatsapp.net')).toMatchObject({ subjectType: 'approval' })
    // the pin is the approval's, but the last file sent is still found for "send that again"
    expect(await lastDocumentFor(deps, message())).toEqual({ sapObject: '13', docEntry: 204, role: 'einvoice_qr' })
  })

  it('says so instead of sending a file over 5 MB without a presigned URL, or one missing from storage', async () => {
    await deliverFile(deps, message(), effect(file('invoice_pdf', { sha256: '3'.repeat(64), sizeBytes: BASE64_LIMIT + 1 })))
    await deliverFile(deps, message(), effect(file('ewaybill', { sha256: '4'.repeat(64) })))
    expect(media).toHaveLength(0)
    expect(texts[0]).toMatch(/too large to send from here/)
    expect(texts[1]).toMatch(/missing from file storage/)
  })

  it('passes a presigned URL when the store has one', async () => {
    const presigned: FileStore = {
      kind: 's3',
      put: async () => undefined,
      get: async () => null,
      has: async () => true,
      presignedUrl: async (key) => `https://bucket.example.test/${key}?sig=1`,
    }
    deps.files = presigned
    const link = file('invoice_pdf', { sha256: '5'.repeat(64), sizeBytes: 9 * 1024 * 1024 })
    await deliverFile(deps, message(), effect(link))
    expect(media[0]!.media).toBe(`https://bucket.example.test/${link.storageKey}?sig=1`)
  })

  it('posts a link on the desk instead of sending', async () => {
    const link = file('invoice_pdf', { sha256: '6'.repeat(64), fileName: 'AR Invoice [Approved]_1.pdf' })
    await deliverFile(deps, message('desk:usr_alex'), effect(link))
    expect(media).toHaveLength(0)
    const thread = await store.listThread('desk:usr_alex')
    expect(thread.at(-1)?.body).toContain(`[AR Invoice \\[Approved\\]_1.pdf](/api/files/${'6'.repeat(64)})`)
  })
})

describe('the attachment rule for Tierra sales orders', () => {
  const tso = (n: number): Ref => ({
    kind: 'tso',
    text: `TSO ${n}`,
    docNo: `TSO/26-27/000${n}`,
    order: { id: `so_${n}`, docNo: `TSO/26-27/000${n}`, status: 'approved', partyName: 'Alpha', cardCode: 'ZC001', total: 100, customerPoNo: null },
  })
  const ctx = (kind: 'internal' | 'party'): ToolContext =>
    ({
      audience: kind === 'internal' ? { kind, userId: 'u', name: 'Alex', role: 'admin' } : { kind, partyGroupId: 'p', name: 'Alpha', cardCodes: [], pans: [], groupSubject: null, speakerName: null },
      cards: kind === 'internal' ? 'all' : [],
      effects: [],
      concerned: [],
    }) as unknown as ToolContext

  it('queues the PDF of a TSO the message names, once, for Tierra people only, and never for three', async () => {
    const deps = {} as AgentDeps
    const internal = ctx('internal')
    expect(await applyAttachmentRule(deps, internal, [tso(1)])).toEqual([])
    expect(internal.effects).toEqual([{ kind: 'send_so_pdf', salesOrderId: 'so_1', annex: false }])
    await applyAttachmentRule(deps, internal, [tso(1)])
    expect(internal.effects).toHaveLength(1)

    const party = ctx('party')
    await applyAttachmentRule(deps, party, [tso(1)])
    expect(party.effects).toEqual([])

    const many = ctx('internal')
    await applyAttachmentRule(deps, many, [tso(1), tso(2), tso(3)])
    expect(many.effects).toEqual([])
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../app'
import { seedIfEmpty } from '../db/seed'
import { FsFileStore } from '../files/store'
import { dataBrief } from '../queries/brief'
import { approvalHistory, documentByKey, fileBySha, filesForDocuments } from '../queries/documents'
import { FakeModel, callTool, say, useTools, type SeenRequest } from '../test/fake-llm'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { loadSapFixture } from '../test/sap'
import type { EvolutionClient, MediaMessage } from '../whatsapp/evolution'
import type { IncomingMessage } from '../whatsapp/parse'
import { routeMessage } from './route'
import { partyCardCodes } from './scope'
import { documentTools } from './tools/documents'
import type { ToolContext } from './tools/types'

// P5 on the synthetic fixture: SAP files (schema att) found per document, sent by send_document and the attachment
// rule, within the audience, and served at /api/files/:sha. Alpha (ZC001) owns invoice 204 = TF/25-26/3 (print, QR
// and an internal-only attachment); Beta (ZC002) owns invoice 201 = TF/25-26/1 (e-way bill only); GRN 502 =
// GR/25-26/2 has a supplier bill, GRN 501 = GR/25-26/1 none.

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const ALEX_PHONE = '919900000000'
const ALEX_JID = `${ALEX_PHONE}@s.whatsapp.net`
const GROUP = '120363888@g.us'
const SHA = {
  print204: '1'.repeat(64),
  qr204: '2'.repeat(64),
  mail204: '3'.repeat(64),
  ewb201: '4'.repeat(64),
  bill502: '5'.repeat(64),
  gasReceipt4001: '6'.repeat(64),
  kycAlpha: '7'.repeat(64),
}

function lastTool(request: SeenRequest): Record<string, any> {
  return JSON.parse(String(request.messages.at(-1)?.content ?? '{}')) as Record<string, any>
}

describe.skipIf(!pg)('SAP documents on demand (synthetic fixture)', () => {
  let conn: Connection
  let dir: string
  let files: FsFileStore
  let deps: AppDeps
  let llm: FakeModel
  let media: MediaMessage[]
  let texts: string[]
  let seq = 0

  beforeAll(async () => {
    const url = await pg!.createDatabase('documents_fixture')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await seedIfEmpty(conn.db, 'secret-pass')
    await conn.store.saveRelation({ userId: 'usr_alex', phoneNumber: ALEX_PHONE })
    const party = await conn.store.createPartyGroup({ name: 'Alpha Snacks', members: [{ kind: 'card_code', value: 'ZC001' }] })
    await conn.store.saveWaGroup(GROUP, { subject: 'Alpha – Tierra', partyGroupId: party.id })
    dir = mkdtempSync(join(tmpdir(), 'tierra-p5-'))
    files = new FsFileStore(dir)
    for (const row of await conn.sql`select sha256, storage_key from att.files`) {
      await files.put(String(row.storage_key), Buffer.from(`bytes of ${String(row.sha256).slice(0, 4)}`), 'application/pdf')
    }
  })

  afterAll(async () => {
    await conn?.close()
    await pg?.stop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    llm = new FakeModel()
    media = []
    texts = []
    const evolution = {
      sendText: async (_number: string, text: string) => {
        texts.push(text)
        return { messageId: `out-t-${++seq}` }
      },
      sendMedia: async (sent: MediaMessage) => {
        media.push(sent)
        return { messageId: `out-m-${++seq}` }
      },
      sendReaction: async () => undefined,
      fetchAllGroups: async () => [],
    } as unknown as EvolutionClient
    deps = {
      store: conn.store,
      evolution,
      sapSql: conn.sql,
      files,
      readPurchaseOrder: async () => ({ kind: 'not_po', reason: 'not used here' }),
      dataBrief: () => dataBrief(conn.sql, conn.store),
      chatModel: llm.model,
      enqueue: async () => true,
      botMode: 'dedicated',
      now: () => new Date(),
      webhookSecret: 'test-secret',
      sessionTtlMs: 60_000,
    }
  })

  function incoming(text: string, where: 'alex' | 'group'): IncomingMessage {
    seq += 1
    return {
      id: `in-${seq}-${Date.now()}`,
      remoteJid: where === 'alex' ? ALEX_JID : GROUP,
      fromMe: false,
      text,
      quotedText: null,
      quotedId: null,
      quotedParticipant: null,
      mentionedJids: [],
      participantJid: where === 'group' ? '919811111111@s.whatsapp.net' : null,
      participantAltJid: null,
      aliasJid: null,
      control: false,
      kind: 'text',
      reaction: null,
      pdf: null,
      raw: null,
      embeddedBase64: null,
    }
  }

  async function say_(text: string, where: 'alex' | 'group' = 'alex'): Promise<string> {
    const message = incoming(text, where)
    await conn.store.claimMessage({ evolutionMessageId: message.id, remoteJid: message.remoteJid, fromMe: false, hasPdf: false, body: text, kind: 'text' })
    return (await routeMessage(deps, message, where === 'alex' ? 'personal' : 'group')) ?? ''
  }

  it('finds files per document within the scope', async () => {
    const all = await filesForDocuments(conn.sql, 'all', [
      { sapObject: '13', docEntry: 204 },
      { sapObject: '13', docEntry: 201 },
      { sapObject: '20', docEntry: 502 },
      { sapObject: '20', docEntry: 501 },
    ])
    expect(all.get('13:204')?.map((row) => row.role)).toEqual(['invoice_pdf', 'einvoice_qr', 'supporting'])
    expect(all.get('13:201')?.map((row) => row.role)).toEqual(['ewaybill'])
    expect(all.get('20:502')?.map((row) => row.fileName)).toEqual(['gamma-bill.pdf'])
    expect(all.has('20:501')).toBe(false)

    const alpha = await partyCardCodes(conn.sql, [], ['ZC001'])
    const scoped = await filesForDocuments(conn.sql, alpha, [
      { sapObject: '13', docEntry: 204 },
      { sapObject: '13', docEntry: 201 },
      { sapObject: '20', docEntry: 502 },
    ])
    expect(scoped.get('13:204')?.map((row) => row.role)).toEqual(['invoice_pdf', 'einvoice_qr'])
    expect([...scoped.keys()]).toEqual(['13:204'])

    expect((await fileBySha(conn.sql, SHA.bill502)).map((row) => [row.docNo, row.docType, row.cardName])).toEqual([
      ['GR/25-26/2', 'grn', 'Gamma Packaging Co'],
    ])
    expect(await fileBySha(conn.sql, 'not-a-hash')).toEqual([])
    expect(await documentByKey(conn.sql, 'all', { sapObject: '13', docEntry: 204 })).toMatchObject({ docNo: 'TF/25-26/3', customerPoNo: 'APO-7001' })
    expect(await documentByKey(conn.sql, alpha, { sapObject: '13', docEntry: 201 })).toBeNull()
  })

  it('sends an invoice, then its e-way bill (none), its QR as an image, and "that" again', async () => {
    llm.script(useTools(callTool('send_document', { doc_no: 'TF/25-26/3' })), say('Sending TF/25-26/3.'))
    await say_('send me invoice TF/25-26/3')
    expect(texts.at(-1)).toContain('Sending TF/25-26/3.')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ number: ALEX_PHONE, mediatype: 'document', mimetype: 'application/pdf', fileName: 'AR Invoice [Approved]_20260331_160500.pdf' })
    expect(Buffer.from(media[0]!.media, 'base64').toString()).toBe('bytes of 1111')
    expect(media[0]!.caption).toContain('TF/25-26/3 · Alpha Snacks Pvt Ltd · ₹1,050 · PO APO-7001')
    expect(await conn.store.getChatContext(ALEX_JID)).toMatchObject({ subjectType: 'sap_document', subjectId: '13:204:invoice_pdf' })

    llm.script(useTools(callTool('send_document', { role: 'ewaybill' })), (seen) => say(String(lastTool(seen).message)))
    await say_('and the e-way bill')
    expect(texts.at(-1)).toContain('SAP has no e-way bill on record for TF/25-26/3.')
    expect(media).toHaveLength(1)

    llm.script(useTools(callTool('send_document', { role: 'einvoice_qr' })), say('Sending the QR.'))
    await say_('send its QR')
    expect(media.at(-1)).toMatchObject({ mediatype: 'image', fileName: 'GSTZENQRtest0204.png' })

    llm.script(useTools(callTool('send_document', {})), say('Sending it again.'))
    await say_('send that again')
    expect(media).toHaveLength(3)
    expect(media.at(-1)).toMatchObject({ mediatype: 'image', fileName: 'GSTZENQRtest0204.png' })
  })

  it('attaches the main file to an answer about one document, says when SAP has none, and never for a list', async () => {
    llm.script(useTools(callTool('get_invoice', { doc_no: 'TF/25-26/1' })), say('TF/25-26/1 is for Beta Retail LLP, ₹5,250.'))
    await say_('what is the value of TF/25-26/1?')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ fileName: '900201000000.pdf' })
    expect(media[0]!.caption).toContain('TF/25-26/1 · E-way bill · Beta Retail LLP')
    expect(llm.requests[1]!.messages.at(-1)?.content).toContain('"file_links":[{"role":"ewaybill"')

    llm.script(say('GR/25-26/1 is a free-issue receipt from Alpha.'))
    await say_('what came in on GR 1?')
    expect(texts.at(-1)).toContain('SAP has no file on record for GR/25-26/1.')
    expect(media).toHaveLength(1)

    llm.script(useTools(callTool('find_invoices', {})), say('Four invoices; want any of their files?'))
    await say_('list the invoices')
    expect(media).toHaveLength(1)
    const rows = lastTool(llm.requests[4]!).rows as Array<Record<string, unknown>>
    expect(rows.find((row) => row.docNo === 'TF/25-26/3')?.files).toEqual(['invoice_pdf', 'einvoice_qr', 'supporting'])
  })

  it('keeps a customer group to its own invoices and customer-facing files', async () => {
    llm.script(useTools(callTool('send_document', { doc_no: 'TF/25-26/1' })), (seen) => say(String(lastTool(seen).message)))
    await say_('send invoice TF/25-26/1', 'group')
    expect(texts.at(-1)).toContain('Not found for your account.')
    expect(media).toHaveLength(0)

    llm.script(
      useTools(callTool('find_invoices', {})),
      (seen) => useTools(callTool('send_document', { doc_no: String((lastTool(seen).rows as Array<{ docNo: string }>)[0]!.docNo) })),
      say('Sending your latest invoice.'),
    )
    await say_('send our last invoice', 'group')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ number: GROUP, fileName: 'AR Invoice [Approved]_20260331_160500.pdf' })

    llm.script(useTools(callTool('send_document', { doc_no: 'TF/25-26/3', role: 'supporting' })), (seen) => say(String(lastTool(seen).message)))
    await say_('send the other attachment of TF/25-26/3', 'group')
    expect(media).toHaveLength(1)
    expect(texts.at(-1)).toContain('SAP has no attachment on record for TF/25-26/3.')
    const seen = JSON.stringify(llm.requests.map((request) => request.messages))
    expect(seen).not.toContain('alpha-mail.pdf')
    expect(seen).not.toContain('900201000000')
  })

  it('serves a file behind sign-in and lists files per document', async () => {
    const app = createApp(deps)
    expect((await app.request(`/api/files/${SHA.print204}`)).status).toBe(401)
    const login = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anju@tierra.test', password: 'secret-pass' }),
    })
    expect(login.status).toBe(200)
    const cookie = `tierra_session=${login.headers.get('set-cookie')?.match(/tierra_session=([^;]+)/)?.[1]}`

    const pdf = await app.request(`/api/files/${SHA.print204}`, { headers: { cookie } })
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(pdf.headers.get('content-disposition')).toContain('inline; filename="AR Invoice _Approved__20260331_160500.pdf"')
    expect(pdf.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await pdf.text()).toBe('bytes of 1111')
    expect((await app.request(`/api/files/${'9'.repeat(64)}`, { headers: { cookie } })).status).toBe(404)
    expect((await app.request('/api/files/..%2F..%2Fetc', { headers: { cookie } })).status).toBe(404)

    const listed = (await (await app.request('/api/document-files?docs=13:204,20:502,20:501,bad', { headers: { cookie } })).json()) as {
      files: Record<string, Array<{ role: string; href: string }>>
    }
    expect(Object.keys(listed.files).sort()).toEqual(['13:204', '20:502'])
    expect(listed.files['20:502']).toEqual([
      { sha256: SHA.bill502, role: 'supporting', fileName: 'gamma-bill.pdf', mime: 'application/pdf', sizeBytes: 700, href: `/api/files/${SHA.bill502}` },
    ])

    const noStore = createApp({ ...deps, files: null })
    expect((await noStore.request(`/api/files/${SHA.print204}`, { headers: { cookie } })).status).toBe(503)

    const s3 = createApp({
      ...deps,
      files: {
        kind: 's3',
        put: async () => undefined,
        get: async () => null,
        has: async (key) => !key.includes('4444'),
        presignedUrl: async (key) => `https://bucket.example.test/${key}?sig=1`,
      },
    })
    const redirected = await s3.request(`/api/files/${SHA.print204}`, { headers: { cookie } })
    expect(redirected.status).toBe(302)
    expect(redirected.headers.get('location')).toBe(`https://bucket.example.test/sap/11/11/${SHA.print204}.pdf?sig=1`)
    // on record but not in the bucket: the same 404 as the fs store, never a redirect to nothing
    const gone = await s3.request(`/api/files/${SHA.ewb201}`, { headers: { cookie } })
    expect(gone.status).toBe(404)
    expect(await gone.json()).toEqual({ error: 'The file is on record but missing from storage' })
    await rmSync(join(dir, 'sap', '44'), { recursive: true, force: true })
    const fsGone = await app.request(`/api/files/${SHA.ewb201}`, { headers: { cookie } })
    expect([fsGone.status, await fsGone.json()]).toEqual([404, { error: 'The file is on record but missing from storage' }])
    await files.put(`sap/44/44/${SHA.ewb201}.pdf`, Buffer.from('bytes of 4444'), 'application/pdf')
  })

  it('keeps payment, journal-entry and business-partner files and approvals to the manager and the admin', async () => {
    // queries: operations access (the office) does not see a file linked only to a payment or a business partner
    expect(await fileBySha(conn.sql, SHA.gasReceipt4001)).toEqual([])
    expect(await fileBySha(conn.sql, SHA.kycAlpha)).toEqual([])
    expect((await fileBySha(conn.sql, SHA.gasReceipt4001, 'finance')).map((row) => row.docNo)).toEqual(['PA/25-26/21'])
    expect((await fileBySha(conn.sql, SHA.bill502)).map((row) => row.docNo)).toEqual(['GR/25-26/2'])
    expect((await fileBySha(conn.sql, SHA.bill502, 'finance')).map((row) => row.docNo).sort()).toEqual(['GR/25-26/2', 'PA/25-26/23'])
    expect((await approvalHistory(conn.sql, { limit: 50 })).rows.map((row) => row.docObject)).not.toContain('46')
    expect((await approvalHistory(conn.sql, { limit: 50, access: 'finance' })).rows.map((row) => row.docObject)).toContain('46')

    // the HTTP API by role
    const app = createApp(deps)
    const cookieFor = async (email: string) => {
      const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret-pass' }) })
      return `tierra_session=${login.headers.get('set-cookie')?.match(/tierra_session=([^;]+)/)?.[1]}`
    }
    const [office, manager] = [await cookieFor('anju@tierra.test'), await cookieFor('joshy@tierra.test')]
    for (const sha of [SHA.gasReceipt4001, SHA.kycAlpha]) {
      expect((await app.request(`/api/files/${sha}`, { headers: { cookie: office } })).status).toBe(404)
      expect((await app.request(`/api/files/${sha}`, { headers: { cookie: manager } })).status).toBe(200)
    }
    expect((await app.request(`/api/files/${SHA.bill502}`, { headers: { cookie: office } })).status).toBe(200)
    const listed = async (cookie: string) =>
      Object.keys(((await (await app.request('/api/document-files?docs=46:4001,46:4003,20:502', { headers: { cookie } })).json()) as { files: object }).files).sort()
    expect(await listed(office)).toEqual(['20:502'])
    expect(await listed(manager)).toEqual(['20:502', '46:4001', '46:4003'])

    // the agent tools by role
    const ctxFor = (role: 'office' | 'manager'): ToolContext => ({
      deps,
      audience: { kind: 'internal', userId: `usr_${role}`, name: role, role },
      cards: 'all',
      dataAsOf: '2026-03-31',
      referenceDay: '2026-03-31',
      messageId: 'm-1',
      via: 'whatsapp',
      effects: [],
    })
    const tool = (name: string) => documentTools.find((row) => row.name === name)!
    expect(await tool('get_document').run(ctxFor('office'), { doc_no: 'PA/25-26/21' })).toMatchObject({
      found: false,
      message: expect.stringContaining('PA/25-26/21 is not available to you'),
    })
    expect(await tool('get_document').run(ctxFor('manager'), { doc_no: 'PA/25-26/21' })).toMatchObject({ found: true })
    const officeSend = ctxFor('office')
    expect(await tool('send_document').run(officeSend, { doc_no: 'ZC001' })).toMatchObject({ sent: false, message: expect.stringContaining('not available to you') })
    expect(officeSend.effects).toEqual([])
    const managerSend = ctxFor('manager')
    expect(await tool('send_document').run(managerSend, { doc_no: 'PA/25-26/21' })).toMatchObject({ queued: true })
    expect(await tool('send_document').run(ctxFor('office'), { doc_no: 'PA/25-26/21' })).toMatchObject({ sent: false, message: expect.stringContaining('not available to you') })
    expect(await tool('get_document').run(ctxFor('office'), { doc_no: 'PA/25-26/99' })).toMatchObject({ found: false, message: 'Document PA/25-26/99 is not in SAP.' })
    const approvals = async (role: 'office' | 'manager') =>
      ((await tool('approval_history').run(ctxFor(role), {})) as { rows: Array<{ docObject: string }> }).rows.map((row) => row.docObject)
    expect(await approvals('office')).not.toContain('46')
    expect(await approvals('manager')).toContain('46')
  })
})

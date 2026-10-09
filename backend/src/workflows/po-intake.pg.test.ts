import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { readPoText } from '../agent/extract'
import type { AgentDeps } from '../agent/deps'
import { listDeskMessages, postDeskTurn } from '../agent/desk'
import { handleIncoming } from '../agent/handle-message'
import { seedIfEmpty } from '../db/seed'
import type { PublicUser } from '../db/types'
import type { ExtractedPo, PoRead } from '../domain/po'
import { inlineEnqueue, runDueJobs } from '../jobs/worker'
import { confirmPoReview, reviewPo } from './po-intake'
import { dataBrief } from '../queries/brief'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { FakeModel, callTool, say, useTools } from '../test/fake-llm'
import { loadSapFixture } from '../test/sap'
import { GSTIN, NORTHWIND_SAP, northwindPo } from '../test/northwind'
import { acceptWebhook } from '../whatsapp/accept'
import type { EvolutionClient } from '../whatsapp/evolution'
import { parseWebhook } from '../whatsapp/parse'

// PO intake end to end on the synthetic SAP fixture plus the invented rows below (every code, name and amount is
// made up). "Northwind" is a retailer with six branch cards on one GSTIN; ZN05 is its DC at site T9QA, which already
// has SAP SO/25-26/9 for PO 4400012345 (invoiced TF/25-26/9). ZFGN500 is a 500 g pack whose carton and salt are
// short now but on order, the shape of a real retail-chain PO's check.

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const ZMAT = readFileSync(join(__dirname, '..', '..', 'test', 'po', 'zmat-poprint.synthetic.txt'), 'utf8')
const GROUP = '120363777@g.us'
const UNMAPPED = '120363888@g.us'
/** A group mapped to another customer (Alpha): a Northwind PO posted there must not be taken as Alpha's, or Northwind's. */
const OTHER = '120363666@g.us'
const ALEX_PHONE = '919900000000'
const STAND_IN = '919811100000@s.whatsapp.net'
const alex: PublicUser = { id: 'usr_alex', email: 'alex.thomas@tierra.test', name: 'Alex Thomas', role: 'admin' }

describe.skipIf(!pg)('PO intake on the synthetic SAP fixture', () => {
  let conn: Connection
  let deps: AgentDeps
  let llm: FakeModel
  let sent: Array<{ number: string; text: string; id: string }>
  let reading: PoRead
  let partyId: string

  beforeAll(async () => {
    const url = await pg!.createDatabase('po_intake')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await conn.sql.unsafe(NORTHWIND_SAP)
    await conn.sql`select erp.refresh()`
    await seedIfEmpty(conn.db, 'secret-pass')
    await conn.store.saveRelation({ userId: 'usr_alex', phoneNumber: ALEX_PHONE })
    const party = await conn.store.createPartyGroup({ name: 'Northwind', alias: 'NW', members: [{ kind: 'pan', value: 'AAACN9999Q' }] })
    partyId = party.id
    await conn.store.saveWaGroup(GROUP, { subject: 'Northwind – Tierra', partyGroupId: party.id })
    const alpha = await conn.store.createPartyGroup({ name: 'Alpha Snacks', members: [{ kind: 'pan', value: 'AAACZ1234A' }] })
    await conn.store.saveWaGroup(OTHER, { subject: 'Alpha – Tierra', partyGroupId: alpha.id })
    await conn.sql`
      insert into customer_sites (party_group_id, site_code, card_code) values (${party.id}, 'T9QA', 'ZN05');
    `
    await conn.sql`
      insert into customer_item_refs (id, party_group_id, article_no, ean, item_code, buyer_uom, pcs_per_uom) values
        ('ref_1', ${party.id}, '700100300', null, 'ZFGB200', 'C01', 30),
        ('ref_2', ${party.id}, '700100900', null, 'ZFGN500', 'C01', 30)`
  })

  afterAll(async () => {
    await conn?.close()
    await pg?.stop()
  })

  beforeEach(() => {
    llm = new FakeModel()
    sent = []
    const evolution = {
      sendText: async (number: string, text: string) => {
        const id = `out-${sent.length + 1}-${Math.random().toString(36).slice(2)}`
        sent.push({ number, text, id })
        return { messageId: id }
      },
      sendMedia: async () => ({ messageId: `media-${Math.random().toString(36).slice(2)}` }),
      sendReaction: async () => undefined,
      fetchAllGroups: async () => [
        { id: GROUP, subject: 'Northwind – Tierra', size: 3 },
        { id: UNMAPPED, subject: 'New buyer chat', size: 2 },
        { id: OTHER, subject: 'Alpha – Tierra', size: 3 },
      ],
      downloadMedia: async () => ({ base64: Buffer.from('%PDF-1.4 po').toString('base64'), mimeType: 'application/pdf', fileName: 'po.pdf' }),
    } as unknown as EvolutionClient
    deps = {
      store: conn.store,
      evolution,
      sapSql: conn.sql,
      readPurchaseOrder: async () => reading,
      dataBrief: () => dataBrief(conn.sql, conn.store),
      chatModel: llm.model,
      enqueue: async () => true,
      botMode: 'dedicated',
      now: () => new Date('2026-04-01T06:00:00Z'),
    }
    deps.enqueue = inlineEnqueue(deps)
  })

  function pdfIn(jid: string, id: string, extra: Record<string, unknown> = {}) {
    return {
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id, remoteJid: jid, fromMe: false, participant: STAND_IN },
        message: { documentMessage: { mimetype: 'application/pdf', fileName: 'PO.pdf', ...extra } },
      },
    }
  }

  async function desk(text: string, pdf = false): Promise<string> {
    const posted = await postDeskTurn(deps, alex, { text, pdf: pdf ? { filename: 'po.pdf', content: Buffer.from('%PDF-1.4') } : null })
    expect(posted.ok).toBe(true)
    return (await listDeskMessages(deps, alex.id)).messages.at(-1)!.text
  }

  it('takes a PDF dropped in the mapped group without a mention: the group hears one line, Alex gets the check', async () => {
    reading = await readPoText({ pages: [ZMAT], creator: 'Form Z_MAT_POPRINT EN' }, { openaiApiKey: '', openaiBaseUrl: 'x', openaiModel: 'x' })
    const accepted = await acceptWebhook({ ...deps, webhookSecret: 's' }, JSON.stringify(pdfIn(GROUP, 'g-po-1')), 's')
    expect(accepted.body).toEqual({ ok: true })

    const toGroup = sent.filter((row) => row.number === GROUP)
    expect(toGroup.map((row) => row.text)).toEqual(["> 🧞‍♂️ Tierra Bot:\n\nReceived PO 4400012345. We'll confirm shortly."])
    const toAlex = sent.filter((row) => row.number === ALEX_PHONE)
    expect(toAlex).toHaveLength(1)
    const summary = toAlex[0]!.text
    expect(summary).toContain('PO 4400012345 (NW, 02-Mar, ₹13,381.20), ship-to T9QA → ZN05 Northwind Kalamassery DC.')
    expect(summary).toContain('Repeat: matches SAP SO/25-26/9 of 05-Mar, invoiced TF/25-26/9. Reply *proceed* to go ahead anyway.')
    expect(summary).toContain('1. 700100200 → ZFGA100: 3 CRT = 150 pcs, make 150 (free −200)')
    expect(summary).toContain('2. 700100300 → ZFGB200: 10 C01 = 300 pcs, 100 from stock, make 200')
    expect(summary).toContain('Banana ZRMBN 143.57 kg (estimated): OK')
    expect(summary).toContain('Verdict: *pass*')
    expect(summary).toContain('\nFrom: group Northwind – Tierra\n')
    expect(summary).not.toContain('⚠')

    const [po] = await conn.store.findCustomerPosByNumber('4400012345')
    expect(po).toMatchObject({
      partyGroupId: partyId,
      cardCode: 'ZN05',
      siteCode: 'T9QA',
      status: 'awaiting_proceed',
      reader: 'z_mat_poprint',
      sourceChat: GROUP,
      sourceSender: '+919811100000',
      resolution: { method: 'site' },
      repeatOf: [{ source: 'sap', docNo: 'SO/25-26/9', invoices: ['TF/25-26/9'] }],
    })
    expect(po!.lines.map((line) => [line.itemCode, line.matchMethod, line.pcs, line.pcsSource, line.unitPrice])).toEqual([
      ['ZFGA100', 'history', 150, 'ea', 24.96],
      ['ZFGB200', 'article', 300, 'ref', 30],
    ])
    const registered = await conn.store.findMessage(toAlex[0]!.id)
    expect(registered).toMatchObject({ purpose: 'po_summary', subjectType: 'customer_po', subjectId: po!.id })
    expect(await conn.store.findMessage(toGroup[0]!.id)).toMatchObject({ subjectType: 'customer_po', subjectId: po!.id })

    // Alex replies *proceed* to that DM: the repeat goes on to the sales order.
    const proceed = parseWebhook({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'dm-proceed', remoteJid: `${ALEX_PHONE}@s.whatsapp.net`, fromMe: false },
        message: { extendedTextMessage: { text: 'proceed', contextInfo: { stanzaId: toAlex[0]!.id } } },
      },
    })
    if (proceed.type !== 'message') throw new Error('expected a message')
    const checksBefore = await conn.sql`select count(*)::int as n from inventory_checks where customer_po_id = ${po!.id}`
    await handleIncoming(deps, proceed.message, 'personal')
    // *proceed* checks the PO again: stock may have moved while it waited
    const checksAfter = await conn.sql`select count(*)::int as n from inventory_checks where customer_po_id = ${po!.id}`
    expect(checksAfter[0]!.n).toBe(checksBefore[0]!.n + 1)
    expect(sent.at(-1)?.text).toBe('> 🧞‍♂️ Tierra Bot:\n\nGoing ahead with PO 4400012345. Raising the sales order now; the approval request follows with the SO PDF.')
    expect((await conn.store.getCustomerPo(po!.id))?.status).toBe('checked')
    expect(llm.calls).toBe(0)
  })

  it('keeps silent on a PDF that is not a PO, and on a group message without a mention', async () => {
    reading = { kind: 'not_po', reason: 'tax invoice' }
    await acceptWebhook({ ...deps, webhookSecret: 's' }, JSON.stringify(pdfIn(GROUP, 'g-invoice')), 's')
    expect(sent).toEqual([])
    const unmapped = await acceptWebhook({ ...deps, webhookSecret: 's' }, JSON.stringify(pdfIn(UNMAPPED, 'u-silent')), 's')
    expect(unmapped.body).toEqual({ ignored: true })
  })

  it('checks a new PO from the desk: pass with incoming, handed on to the sales order', async () => {
    reading = { kind: 'po', po: northwindPo(), reader: 'llm' }
    const reply = await desk('', true)
    expect(reply).toContain('PO 4400099999 (NW, 20-Mar, ₹52,920.00), ship-to T9QA → ZN05 Northwind Kalamassery DC.')
    expect(reply).toContain('1. 700100900 → ZFGN500: 12 C01 = 360 pcs, make 360 (free −1,500)')
    expect(reply).toContain('Laminate ZPMLMN 3.96 kg: OK, free 90')
    expect(reply).toContain('Carton ZPMCN5 12 nos: free 8, short 4 now, covered by 500 on order (PO/25-26/3)')
    expect(reply).toContain('Seasoning ZFLSALT 1.44 kg: free −2, short 1.44 now, covered by 200 on order')
    expect(reply).toContain('Banana ZRMBN 612 kg: OK')
    expect(reply).toContain('Oil ZOILP 45: OK')
    expect(reply).toContain('Warnings: Tape ZPMTP 0.72: free 0, short 0.72, nothing on order; Consumable ZCSRIB 0.07')
    expect(reply).toContain('Verdict: *pass with incoming* (ZPMCN5, ZFLSALT arrive on open purchase orders)')
    expect(reply).toContain('Raising the sales order now; the approval request follows with the SO PDF.')
    const [po] = await conn.store.findCustomerPosByNumber('4400099999')
    expect(po).toMatchObject({ status: 'checked', revision: 1, repeatOf: [] })
    expect((await conn.store.latestInventoryCheck(po!.id))?.verdict).toBe('pass_with_incoming')

    // the same PO again is a repeat of the one received here: the next revision, waiting for *proceed*
    const again = await desk('', true)
    expect(again).toMatch(/Repeat: matches the PO already received here on \d{2}-[A-Z][a-z]{2} \(checked\)\. Reply \*proceed\*/)
    expect((await conn.store.findCustomerPosByNumber('4400099999')).map((row) => [row.revision, row.status])).toEqual([
      [2, 'awaiting_proceed'],
      [1, 'checked'],
    ])
    expect(await desk('proceed 4400099999')).toBe('Going ahead with PO 4400099999. Raising the sales order now; the approval request follows with the SO PDF.')
  })

  it('sends a PO from an unmapped group with an ambiguous GSTIN to the office, guessing no card', async () => {
    reading = {
      kind: 'po',
      // a PO number unlike Northwind's earlier ones, so SAP history cannot pick the card either
      po: northwindPo({ poNumber: '7700055555', siteCode: 'Q1ZZ', shipToAddress: 'Somewhere else, Kerala - 690001' }),
      reader: 'llm',
    }
    const message = parseWebhook(pdfIn(UNMAPPED, 'u-po', { caption: '@919900000000 our PO' }))
    if (message.type !== 'message') throw new Error('expected a message')
    await handleIncoming(deps, message.message, 'group')
    expect(sent.filter((row) => row.number === UNMAPPED).map((row) => row.text)).toEqual([
      "> 🧞‍♂️ Tierra Bot:\n\nReceived PO 7700055555. We'll confirm shortly.",
    ])
    const [po] = await conn.store.findCustomerPosByNumber('7700055555')
    expect(po).toMatchObject({ status: 'needs_review', cardCode: null, partyGroupId: partyId })
    expect(po!.reviewReason).toContain(`Ship-to GSTIN ${GSTIN} belongs to 6 customer cards (ZN01, ZN02, ZN03, ZN04, ZN05, ZN06), site Q1ZZ is not known`)
    const tasks = (await conn.store.listTasks()).filter((task) => task.createdAt && (task.subjectId === UNMAPPED || task.subjectId === po!.id))
    expect(tasks.map((task) => [task.title, task.assigneeRole, task.subjectType]).sort()).toEqual([
      ['Map WhatsApp group New buyer chat', 'office', 'wa_group'],
      ['Review PO 7700055555', 'office', 'customer_po'],
    ])
    expect(sent.find((row) => row.number === ALEX_PHONE)?.text).toContain('Needs review: Ship-to GSTIN')
  })

  it('answers "can we make 10,000?" with the check_order dry run and explains a PO check', async () => {
    llm.script(useTools(callTool('check_order', { lines: [{ item_code: 'ZFGN500', qty: 10000 }] })), say('No.'))
    await desk('can we make 10,000 ZFGN500?')
    const dry = JSON.parse(llm.toolResults()[0]!) as Record<string, any>
    expect(dry.verdict).toBe('fail')
    const short = dry.materials.filter((row: { status: string }) => row.status === 'short')
    expect(short.map((row: Record<string, unknown>) => [row.item, row.shortNow, row.shortAfterIncoming])).toEqual([
      ['ZPMLMN', 20, 20],
      ['ZOILP', 150, 145],
      ['ZPMTP', 20, 20],
      ['ZCSRIB', 2, 2],
    ])
    expect((await conn.store.getInventoryCheck(dry.checkId))?.kind).toBe('dry_run')

    llm.script(useTools(callTool('explain_check', { po_no: '4400099999' })), say('ok'))
    await desk('why is PO 4400099999 pass with incoming?')
    const explained = JSON.parse(llm.toolResults()[0]!) as Record<string, any>
    expect(explained.customerPo).toMatchObject({ poNo: '4400099999', revision: 2, cardCode: 'ZN05' })
    expect(explained.check.verdict).toBe('pass_with_incoming')
    expect(explained.rules.join(' ')).toContain('pass_with_incoming when the shortage is covered by open purchase orders')
  })

  it('never takes a PO for another customer from a mapped group: the same PDF in a group of a different party goes to review, nothing raised', async () => {
    reading = { kind: 'po', po: northwindPo({ poNumber: '4400066666' }), reader: 'llm' }
    const accepted = await acceptWebhook({ ...deps, webhookSecret: 's' }, JSON.stringify(pdfIn(OTHER, 'o-po-1')), 's')
    expect(accepted.body).toEqual({ ok: true })
    // the group hears the neutral line only
    expect(sent.filter((row) => row.number === OTHER).map((row) => row.text)).toEqual(["> 🧞‍♂️ Tierra Bot:\n\nReceived PO 4400066666. We'll confirm shortly."])
    const [po] = await conn.store.findCustomerPosByNumber('4400066666')
    expect(po).toMatchObject({ status: 'needs_review', cardCode: null })
    expect(po!.partyName).toBe('Alpha Snacks')
    expect(po!.reviewReason).toContain("PO from group Alpha – Tierra names customer Northwind Kalamassery DC (ZN05), which is not one of Alpha Snacks's cards but NW's.")
    expect(await conn.store.findSalesOrderForPo(po!.id)).toBeNull()
    expect(await conn.store.listProcurementRequests({ subjectId: po!.id })).toEqual([])
    expect((await conn.store.listTasks()).filter((task) => task.subjectId === po!.id).map((task) => [task.title, task.kind])).toEqual([['Review PO 4400066666', 'review']])
    const toAlex = sent.filter((row) => row.number === ALEX_PHONE).at(-1)!.text
    expect(toAlex).toContain('From: group Alpha – Tierra')
    expect(toAlex).toContain('Needs review: PO from group Alpha – Tierra names customer Northwind Kalamassery DC')

    // the office sets the right customer and confirms: the PO carries on as Northwind's (C3)
    const reviewed = await reviewPo(deps, po!.id, { cardCode: 'ZN05' })
    expect(reviewed).toMatchObject({ cardCode: 'ZN05', partyName: 'Northwind', status: 'needs_review' })
    const confirmed = await confirmPoReview(deps, po!.id)
    expect(confirmed.po.status).toBe('checked')
    expect(confirmed.next).toBe('Raising the sales order now; the approval request follows with the SO PDF.')
    expect(confirmed.summary).toContain('Confirmed by the office. Raising the sales order now')
    expect((await conn.store.listTasks()).find((task) => task.subjectId === po!.id && task.kind === 'review')?.status).toBe('done')
    await runDueJobs(deps, new Date('2026-04-01T06:01:00Z'))
    expect((await conn.store.findSalesOrderForPo(po!.id))?.cardCode).toBe('ZN05')
  })

  it('holds a PO from an unknown number until the office confirms it, and confirms item codes the reader could not match', async () => {
    const line = northwindPo().lines[0]!
    reading = {
      kind: 'po',
      po: northwindPo({ poNumber: '4400055555', lines: [{ ...line, articleNo: '999000111', description: 'NEW PACK BANANA CHIPS 500 G' }] }),
      reader: 'llm',
    }
    const dm = await acceptWebhook(
      { ...deps, webhookSecret: 's' },
      JSON.stringify({ event: 'messages.upsert', instance: 'tierra', data: { key: { id: 'unknown-po', remoteJid: STAND_IN, fromMe: false }, message: { documentMessage: { mimetype: 'application/pdf', fileName: 'PO.pdf' } } } }),
      's',
    )
    expect(dm.body).toEqual({ ok: true })
    const [po] = await conn.store.findCustomerPosByNumber('4400055555')
    expect(po).toMatchObject({ status: 'needs_review', cardCode: 'ZN05', raisedBy: null })
    expect(po!.reviewReason).toContain('Sent by +919811100000, which is not a Tierra account: the office must confirm this PO before anything is raised.')
    expect(await conn.store.findSalesOrderForPo(po!.id)).toBeNull()
    expect(await conn.store.listProcurementRequests({ subjectId: po!.id })).toEqual([])
    expect((await conn.store.listTasks()).filter((task) => task.subjectId === po!.id && task.kind === 'procurement')).toEqual([])
    const toAlex = sent.filter((row) => row.number === ALEX_PHONE).at(-1)!.text
    expect(toAlex).toContain('From: unknown number +919811100000\n⚠ Not a Tierra account: nothing is raised for this PO until the office confirms it.')
    // the sender hears only the neutral line
    expect(sent.find((row) => row.number === '919811100000')?.text).toBe("> 🧞‍♂️ Tierra Bot:\n\nReceived PO 4400055555. We'll confirm shortly.")

    // nothing goes on until every line is confirmed
    await expect(confirmPoReview(deps, po!.id)).rejects.toThrow('Confirm the item of line 1 first.')
    await expect(reviewPo(deps, po!.id, { lines: [{ lineNo: 1, itemCode: 'ZPMLMN' }] })).rejects.toThrow('Line 1: ZPMLMN is not a finished good.')
    const fixed = await reviewPo(deps, po!.id, { lines: [{ lineNo: 1, itemCode: 'zfgn500' }] })
    expect(fixed.lines[0]).toMatchObject({ itemCode: 'ZFGN500', matchMethod: 'manual', matchConfirmed: true, pcs: 360, pcsSource: 'npu', unitPrice: 140 })
    const confirmed = await confirmPoReview(deps, po!.id)
    expect(confirmed.po.status).toBe('checked')
    await expect(confirmPoReview(deps, po!.id)).rejects.toThrow('is checked, not waiting for review')
  })

  it('never loses a PO when intake breaks halfway: the row it made goes to review with the error, and the office has a task', async () => {
    reading = { kind: 'po', po: northwindPo({ poNumber: '4400044444' }), reader: 'llm' }
    const save = conn.store.saveInventoryCheck.bind(conn.store)
    conn.store.saveInventoryCheck = async () => {
      throw new Error('disk full')
    }
    try {
      await desk('', true)
    } finally {
      conn.store.saveInventoryCheck = save
    }
    const [po] = await conn.store.findCustomerPosByNumber('4400044444')
    expect(po).toMatchObject({ status: 'needs_review', documentId: expect.any(String) })
    expect(po!.reviewReason).toBe('The PO could not be processed automatically (disk full). Check it by hand.')
    expect((await conn.store.listTasks()).find((task) => task.subjectId === po!.id)).toMatchObject({ kind: 'review', assigneeRole: 'office' })
    const reply = (await listDeskMessages(deps, alex.id)).messages.at(-1)!.text
    expect(reply).toContain('Needs review: The PO could not be processed automatically (disk full).')
  })
})

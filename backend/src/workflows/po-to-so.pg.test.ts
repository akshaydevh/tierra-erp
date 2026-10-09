import pdfParse from 'pdf-parse'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { AgentDeps } from '../agent/deps'
import { handleIncoming } from '../agent/handle-message'
import { LlmUnavailableError } from '../agent/llm'
import { NOT_CONFIGURED } from '../agent/loop'
import { seedIfEmpty } from '../db/seed'
import type { ExtractedPo, PoRead } from '../domain/po'
import { inlineEnqueue, runDueJobs } from '../jobs/worker'
import { dataBrief } from '../queries/brief'
import { FakeModel, callTool, say, useTools } from '../test/fake-llm'
import { NORTHWIND_SAP, northwindPo } from '../test/northwind'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { loadSapFixture } from '../test/sap'
import { acceptWebhook } from '../whatsapp/accept'
import type { EvolutionClient, MediaMessage } from '../whatsapp/evolution'
import { parseWebhook } from '../whatsapp/parse'
import { processPo, sendToGroup } from './po-to-so'
import { absorbStockAdjustments, syncWithSap } from './sap-sync'

// PO -> TSO -> approval -> customer group on the synthetic SAP fixture plus the invented Northwind rows (test/northwind.ts).
// The bot talks to a fake Evolution; the model is scripted. Every code, name and amount here is made up.

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const GROUP = '120363777@g.us'
const ALEX = '919900000000'
const JOSHY = '919900000001'
const ANJU = '919900000002'
const BOT = '> 🧞‍♂️ Tierra Bot:\n\n'

type Sent = { number: string; text: string; id: string }
type Media = MediaMessage & { id: string }

type World = {
  conn: Connection
  deps: AgentDeps
  llm: FakeModel
  sent: Sent[]
  media: Media[]
  clock: { at: number }
  reading: { value: PoRead }
  groupSend: { fail: 'after' | null }
}

async function world(name: string, extraSql = ''): Promise<World> {
  const url = await pg!.createDatabase(name)
  await runMigrations(url)
  await loadSapFixture(url)
  const conn = connect(url)
  await conn.sql.unsafe(NORTHWIND_SAP + extraSql)
  await conn.sql`select erp.refresh()`
  await seedIfEmpty(conn.db, 'secret-pass')
  for (const [userId, phone] of [['usr_alex', ALEX], ['usr_joshy', JOSHY], ['usr_anju', ANJU]] as const) {
    await conn.store.saveRelation({ userId, phoneNumber: phone })
  }
  const party = await conn.store.createPartyGroup({ name: 'Northwind', alias: 'NW', members: [{ kind: 'pan', value: 'AAACN9999Q' }] })
  await conn.store.saveWaGroup(GROUP, { subject: 'Northwind – Tierra', partyGroupId: party.id })
  await conn.sql`insert into customer_sites (party_group_id, site_code, card_code) values (${party.id}, 'T9QA', 'ZN05')`
  await conn.sql`
    insert into customer_item_refs (id, party_group_id, article_no, ean, item_code, buyer_uom, pcs_per_uom) values
      ('ref_2', ${party.id}, '700100900', null, 'ZFGN500', 'C01', 30)`
  const w = {
    conn,
    llm: new FakeModel(),
    sent: [] as Sent[],
    media: [] as Media[],
    clock: { at: Date.parse('2026-04-01T06:00:00Z') },
    reading: { value: { kind: 'po', po: northwindPo(), reader: 'llm' } as PoRead },
    groupSend: { fail: null as 'after' | null },
  } as World
  let n = 0
  const evolution = {
    sendText: async (number: string, text: string) => {
      n += 1
      w.sent.push({ number, text, id: `${name}-t${n}` })
      return { messageId: `${name}-t${n}` }
    },
    sendMedia: async (media: MediaMessage) => {
      n += 1
      w.media.push({ ...media, id: `${name}-m${n}` })
      if (media.number === GROUP && w.groupSend.fail === 'after') throw new Error('worker killed after the send')
      return { messageId: `${name}-m${n}` }
    },
    sendReaction: async () => undefined,
    fetchAllGroups: async () => [{ id: GROUP, subject: 'Northwind – Tierra', size: 3 }],
    downloadMedia: async () => ({ base64: Buffer.from('%PDF-1.4 po').toString('base64'), mimeType: 'application/pdf', fileName: 'po.pdf' }),
  } as unknown as EvolutionClient
  w.llm.fallback = () => {
    throw new LlmUnavailableError()
  }
  w.deps = {
    store: conn.store,
    evolution,
    sapSql: conn.sql,
    readPurchaseOrder: async () => w.reading.value,
    dataBrief: () => dataBrief(conn.sql, conn.store),
    chatModel: w.llm.model,
    enqueue: async () => true,
    botMode: 'dedicated',
    now: () => new Date(w.clock.at),
  }
  w.deps.enqueue = inlineEnqueue(w.deps)
  return w
}

function dm(id: string, from: string, message: Record<string, unknown>) {
  return { event: 'messages.upsert', instance: 'tierra', data: { key: { id, remoteJid: `${from}@s.whatsapp.net`, fromMe: false }, message } }
}

async function hook(w: World, body: unknown) {
  return (await acceptWebhook({ ...w.deps, webhookSecret: 's' }, JSON.stringify(body), 's')).body
}

let seq = 0
const text = (w: World, from: string, body: string, quotedId?: string) =>
  hook(w, dm(`in-${(seq += 1)}`, from, quotedId ? { extendedTextMessage: { text: body, contextInfo: { stanzaId: quotedId } } } : { conversation: body }))
const react = (w: World, from: string, targetId: string, emoji: string, fromMe = false) =>
  hook(w, {
    event: 'messages.upsert',
    instance: 'tierra',
    data: {
      key: { id: `re-${(seq += 1)}`, remoteJid: `${from}@s.whatsapp.net`, fromMe },
      message: { reactionMessage: { key: { id: targetId, remoteJid: `${from}@s.whatsapp.net`, fromMe: true }, text: emoji } },
    },
  })
async function pdfFromAlex(w: World) {
  const parsed = parseWebhook(dm(`pdf-${(seq += 1)}`, ALEX, { documentMessage: { mimetype: 'application/pdf', fileName: 'PO.pdf' } }))
  if (parsed.type !== 'message') throw new Error('expected a message')
  await handleIncoming(w.deps, parsed.message, 'personal')
}
async function later(w: World, ms: number) {
  w.clock.at += ms
  return runDueJobs(w.deps, new Date(w.clock.at))
}
const toAlex = (w: World) => w.sent.filter((row) => row.number === ALEX).map((row) => row.text.replace(BOT, ''))
const toJoshy = (w: World) => w.sent.filter((row) => row.number === JOSHY)

function poWith(qtyC01: number, poNumber: string): ExtractedPo {
  const base = northwindPo()
  const value = qtyC01 * 4200
  const tax = Math.round(value * 5) / 100
  return {
    ...base,
    poNumber,
    basicTotal: value,
    taxTotal: tax,
    total: value + tax,
    lines: [{ ...base.lines[0]!, qty: qtyC01, lineTotal: value, taxAmount: tax }],
  }
}

describe.skipIf(!pg)('PO -> TSO -> approval -> customer group', () => {
  let w: World

  beforeAll(async () => {
    w = await world('po_to_so')
  })

  afterAll(async () => {
    await w?.conn.close()
    await pg?.stop()
  })

  beforeEach(() => {
    w.sent.length = 0
    w.media.length = 0
    w.llm.requests = []
    w.llm.script()
  })

  it('raises TSO/26-27/0001 from a passing PO, tasks the manager and sends Alex one approval (SO + annex)', async () => {
    await pdfFromAlex(w)
    expect(toAlex(w).at(-1)).toContain('Raising the sales order now; the approval request follows with the SO PDF.')
    expect(await w.conn.store.listSalesOrders()).toEqual([])
    expect(await later(w, 3_000)).toBeGreaterThan(0)

    const [order] = await w.conn.store.listSalesOrders()
    expect(order).toMatchObject({
      docNo: 'TSO/26-27/0001',
      status: 'pending_approval',
      cardCode: 'ZN05',
      siteCode: 'T9QA',
      vendorCode: '99887766',
      taxKind: 'cgst_sgst',
      basicTotal: 50400,
      cgst: 1260,
      sgst: 1260,
      total: 52920,
    })
    expect(order!.lines.map((line) => [line.itemCode, line.pcs, line.cartons, line.unitPrice, line.hsn, line.poHsn, line.reservedPcs, line.toMake])).toEqual([
      ['ZFGN500', 360, 12, 140, '99990001', '21069091', 0, 360],
    ])

    const tasks = await w.conn.store.listTasks()
    const procurement = tasks.find((task) => task.kind === 'procurement')!
    expect(procurement).toMatchObject({
      title: 'Complete procurement for TSO/26-27/0001 — expedite ZPMCN5 (4 nos short now), ZFLSALT (1.44 kg short now); make 360 × ZFGN500',
      assigneeName: 'Joshy',
      subjectType: 'sales_order',
      subjectId: order!.id,
    })
    expect(toJoshy(w).map((row) => row.text)).toEqual([expect.stringContaining('*Complete procurement for TSO/26-27/0001')])
    const requests = await w.conn.store.listProcurementRequests({ subjectId: order!.id })
    expect(requests.map((row) => [row.reason, row.itemCode, row.qty]).sort()).toEqual([
      ['expedite', 'ZFLSALT', 1.44],
      ['expedite', 'ZPMCN5', 4],
      ['production', 'ZFGN500', 360],
    ])

    // one approval message: the SO PDF with the summary as caption, then the internal annex
    const toAlexMedia = w.media.filter((row) => row.number === ALEX)
    expect(toAlexMedia.map((row) => row.fileName)).toEqual(['TSO-26-27-0001-v1.pdf', 'TSO-26-27-0001-v1-annex.pdf'])
    expect(toAlexMedia[0]!.caption).toContain('Approve sales order *TSO/26-27/0001*')
    expect(toAlexMedia[0]!.caption).toContain('Total *₹52,920.00* (₹50,400.00 + CGST ₹1,260.00 + SGST ₹1,260.00)')
    expect(toAlexMedia[0]!.caption).toContain('Note: you sent this PO yourself')
    // where the PO came from, on the approval request itself
    expect(toAlexMedia[0]!.caption).toContain('PO 4400099999 of 20-Mar · delivery 01-Apr\nFrom: Alex Thomas (DM)\n')
    expect(toAlexMedia[0]!.caption).not.toContain('⚠')
    const approval = await w.conn.store.findApprovalByMessage(toAlexMedia[0]!.id)
    expect(approval).toMatchObject({ status: 'pending', version: 1, selfRaised: true, waMessageIds: toAlexMedia.map((row) => row.id) })
    expect(await w.conn.store.getTask(approval!.taskId!)).toMatchObject({ kind: 'approval', assigneeName: 'Alex Thomas', waMessageId: toAlexMedia[0]!.id })
    expect(w.sent.filter((row) => row.number === ALEX && row.text.includes('Approve sales order'))).toEqual([])

    const pdf = (await pdfParse(Buffer.from(toAlexMedia[0]!.media, 'base64'))).text
    expect(pdf).toContain('SALES ORDER')
    expect(pdf).toContain('PENDING APPROVAL')
    expect(pdf).toContain('99990001')
    expect(pdf).toContain('Rupees Fifty Two Thousand Nine Hundred Twenty Only')
    expect(pdf).not.toContain('21069091')
    const annex = (await pdfParse(Buffer.from(toAlexMedia[1]!.media, 'base64'))).text
    expect(annex).toContain('PO HSN 21069091 differs from SAP HSN 99990001')
    expect(annex).toContain('Internal only')

    // the TSO holds its stock at once: the components of what it makes
    expect(await w.conn.store.stockOverlays(['ZFGN500', 'ZPMLMN'])).toEqual({ ZPMLMN: { reserved: 3.96, adjustments: 0 }, ZFGN500: { reserved: 0, adjustments: 0 } })

    // a re-run job (a killed worker) makes no second TSO, task or request
    const po = (await w.conn.store.findCustomerPosByNumber('4400099999'))[0]!
    await processPo(w.deps, po.id, order!.checkId)
    expect((await w.conn.store.listSalesOrders()).length).toBe(1)
    expect((await w.conn.store.listTasks()).filter((task) => task.kind === 'procurement').length).toBe(1)
    expect((await w.conn.store.listProcurementRequests({ subjectId: order!.id })).length).toBe(3)
  })

  it('answers questions while the approval is pinned and never approves on doubt', async () => {
    const [approval] = await w.conn.store.listApprovals({ status: 'pending' })
    const pdfId = approval!.waMessageIds[0]!
    w.llm.script(useTools(callTool('get_so', {})), say('Delivery 01-04-2026, DDP, site T9QA.'))
    await text(w, ALEX, "what's the delivery date?")
    expect(w.llm.user()).toContain('This conversation is about the Tierra sales order TSO/26-27/0001')
    const so = JSON.parse(w.llm.toolResults()[0]!)
    expect(so).toMatchObject({ docNo: 'TSO/26-27/0001', deliveryDate: '2026-04-01', deliveryTerm: null, site: 'T9QA', status: 'pending_approval' })
    expect(toAlex(w).at(-1)).toBe('Delivery 01-04-2026, DDP, site T9QA.')

    w.llm.script(useTools(callTool('explain_check', { customer_po_id: so.customerPoId })), say('FG free is −1,500, so all 360 are made.'))
    await text(w, ALEX, 'why make line 1?', pdfId)
    expect(JSON.parse(w.llm.toolResults()[0]!).check.finishedGoods[0]).toMatchObject({ item: 'ZFGN500', free: -1500, toMake: 360 })

    // right after a tool-loop answer the admin is talking with the bot: no approval classifier, straight to the loop
    w.llm.script(useTools(callTool('send_so_pdf', {})), say('Sent it again.'))
    const before = w.media.length
    const calls = w.llm.requests.length
    await text(w, ALEX, 'send pdf again')
    expect(w.llm.requests.length).toBe(calls + 2)
    expect(w.llm.requests.slice(calls).every((request) => !request.messages.some((m) => String(m.content).includes('classify')))).toBe(true)
    expect(toAlex(w).at(-1)).toBe('Sent it again.')
    expect(w.media.slice(before).map((row) => [row.number, row.fileName])).toEqual([[ALEX, 'TSO-26-27-0001-v1.pdf']])

    w.llm.script(say('It matches the PO: ₹140 a piece.'))
    await text(w, ALEX, 'is the price ok?', pdfId)
    w.llm.script(say('Noted.'))
    await text(w, ALEX, 'not ok yet', pdfId)
    // no model at all: the classifier and the loop degrade to a question and the fallback line
    await text(w, ALEX, 'looks fine to me')
    expect(toAlex(w).at(-1)).toBe(NOT_CONFIGURED)
    expect((await w.conn.store.getApproval(approval!.id))!.status).toBe('pending')
  })

  it('refuses 👍 from anyone but the admin and ignores 👍 on other messages and 👀', async () => {
    const [approval] = await w.conn.store.listApprovals({ status: 'pending' })
    const pdfId = approval!.waMessageIds[0]!
    await react(w, JOSHY, pdfId, '👍')
    await react(w, ANJU, pdfId, '👍🏽')
    expect(w.sent.map((row) => [row.number, row.text.replace(BOT, '')])).toEqual([
      [JOSHY, 'Only the admin can approve TSO/26-27/0001.'],
      [ANJU, 'Only the admin can approve TSO/26-27/0001.'],
    ])
    w.sent.length = 0
    const unrelated = (await w.conn.store.listThread(`${ALEX}@s.whatsapp.net`)).filter((row) => row.fromMe && !row.hasPdf).at(-1)!.id
    expect(await react(w, ALEX, unrelated, '👍')).toEqual({ ok: true })
    expect(await react(w, ALEX, 'not-a-bot-message', '👍')).toEqual({ ignored: true })
    expect(await react(w, ALEX, pdfId, '👀', true)).toEqual({ ignored: true })
    await react(w, ALEX, pdfId, '👀')
    expect(w.sent).toEqual([])
    expect((await w.conn.store.getApproval(approval!.id))!.status).toBe('pending')
  })

  it('approves on 👍 with a 60 s window, *stop* cancels, the model approves plain words, and the group gets one copy', async () => {
    const [approval] = await w.conn.store.listApprovals({ status: 'pending' })
    const pdfId = approval!.waMessageIds[0]!
    await react(w, ALEX, pdfId, '👍🏾')
    expect(toAlex(w)).toEqual([
      'Approved TSO/26-27/0001 — sending page to *Northwind – Tierra* in 60 s. Reply *stop* to cancel. (Recorded as self-approved.)',
    ])
    await text(w, ALEX, 'stop')
    expect(toAlex(w).at(-1)).toBe('Stopped. TSO/26-27/0001 was not sent and is waiting for approval again.')
    expect(await later(w, 61_000)).toBe(0)
    expect((await w.conn.store.getApproval(approval!.id))!.status).toBe('pending')

    // rule 4, right after the bot's own reply: plain approval words, and the model says approve
    w.llm.script(say('{"intent": "approve", "note": null}'))
    await text(w, ALEX, 'yes, go ahead')
    expect(toAlex(w).at(-1)).toContain('Approved TSO/26-27/0001 — sending page to *Northwind – Tierra* in 60 s.')
    expect((await w.conn.store.getApproval(approval!.id))!).toMatchObject({ status: 'approved', via: 'llm' })
    await text(w, ALEX, 'stop')
    expect(toAlex(w).at(-1)).toBe('Stopped. TSO/26-27/0001 was not sent and is waiting for approval again.')

    // the model's "approve" alone is not enough: the words must be approval words
    w.llm.script(say('{"intent": "approve", "note": null}'), say('Reply *approve* or react 👍 when you are ready.'))
    const pinBefore = await w.conn.store.getChatContext(`${ALEX}@s.whatsapp.net`)
    await text(w, ALEX, 'looks good, go ahead and send it to them')
    // ordinary messages never refresh the approval pin (only the request and a quote of it do)
    expect(await w.conn.store.getChatContext(`${ALEX}@s.whatsapp.net`)).toEqual(pinBefore)
    expect(toAlex(w).at(-1)).toBe('Reply *approve* or react 👍 when you are ready.')
    expect((await w.conn.store.getApproval(approval!.id))!.status).toBe('pending')
    // and right after that tool-loop answer, rule 4 does not run at all (no classifier call, nothing approved)
    w.llm.script(say('Say *approve* to approve it.'))
    const calls = w.llm.requests.length
    await text(w, ALEX, 'yes, go ahead')
    expect(w.llm.requests.length).toBe(calls + 1)
    expect((await w.conn.store.getApproval(approval!.id))!.status).toBe('pending')

    await text(w, ALEX, 'approve')
    expect(toAlex(w).at(-1)).toContain('Approved TSO/26-27/0001 — sending page to *Northwind – Tierra* in 60 s.')
    await react(w, ALEX, pdfId, '👍')
    expect(toAlex(w).filter((line) => line.startsWith('Approved')).length).toBe(3)
    expect(w.media.filter((row) => row.number === GROUP)).toEqual([])
    expect(await later(w, 30_000)).toBe(0)
    expect(await later(w, 31_000)).toBe(1)

    const group = w.media.filter((row) => row.number === GROUP)
    expect(group.map((row) => [row.fileName, row.caption])).toEqual([
      ['TSO-26-27-0001-v1-approved.pdf', `${BOT}Sales order TSO/26-27/0001 for PO 4400099999, delivery 01-Apr.`],
    ])
    const copy = (await pdfParse(Buffer.from(group[0]!.media, 'base64'))).text
    expect(copy).toContain('APPROVED · Alex Thomas')
    expect(copy).not.toContain('Internal')
    expect(toAlex(w).at(-1)).toBe('Sent TSO/26-27/0001 to *Northwind – Tierra*.')
    expect(toJoshy(w).at(-1)?.text).toContain('TSO/26-27/0001 (NW, PO 4400099999) was approved by Alex Thomas and sent to Northwind – Tierra.')
    const decided = (await w.conn.store.getApproval(approval!.id))!
    expect(decided).toMatchObject({ status: 'approved', via: 'text', channel: 'whatsapp', decidedByName: 'Alex Thomas' })
    expect(await w.conn.store.getTask(decided.taskId!)).toMatchObject({ status: 'done' })
    expect((await w.conn.store.getSalesOrder(decided.subjectId))!.status).toBe('sent')

    await sendToGroup(w.deps, approval!.id)
    await react(w, ALEX, pdfId, '👍')
    expect(w.media.filter((row) => row.number === GROUP).length).toBe(1)
  })

  it('reserves TSO stock in dry runs', async () => {
    w.llm.script(useTools(callTool('check_order', { lines: [{ item_code: 'ZPMLMN', qty: 1 }] }), callTool('free_stock', { item_code: 'ZPMLMN' })), say('ok'))
    await text(w, ALEX, 'how much ZPMLMN is free?')
    const free = JSON.parse(w.llm.toolResults()[1]!)
    expect(free.rows[0]).toMatchObject({ itemCode: 'ZPMLMN', free: 90, reservedByTierraOrders: 3.96, freeAfterReservations: 86.04 })
  })

  it('sends back v1, ignores 👍 on it, approves v2 and never resends a group copy after a crash', async () => {
    w.reading.value = { kind: 'po', po: poWith(10, '4400099998'), reader: 'llm' }
    await pdfFromAlex(w)
    await later(w, 3_000)
    const order = (await w.conn.store.findSalesOrderByNo('TSO/26-27/0002'))!
    const v1 = (await w.conn.store.listApprovals({ subjectId: order.id }))[0]!
    await text(w, ALEX, 'send back: deliver by 5 April', v1.waMessageIds[0])
    expect(toAlex(w).at(-1)).toBe('Sent back TSO/26-27/0002: “deliver by 5 April”. The office will revise it; version 2 comes back to you for approval.')
    const revise = (await w.conn.store.listTasks()).find((task) => task.subjectType === 'sales_order_revision')!
    expect(revise).toMatchObject({ title: 'Revise TSO/26-27/0002: deliver by 5 April', assigneeName: 'Anju' })
    expect((await w.conn.store.getTask(v1.taskId!))!.status).toBe('cancelled')

    w.media.length = 0
    await text(w, ANJU, 'done', w.sent.find((row) => row.number === ANJU)!.id)
    await later(w, 0)
    const v2 = (await w.conn.store.listApprovals({ subjectId: order.id })).find((row) => row.version === 2)!
    expect(w.media.filter((row) => row.number === ALEX).map((row) => row.fileName)).toEqual(['TSO-26-27-0002-v2.pdf', 'TSO-26-27-0002-v2-annex.pdf'])
    expect(w.media[0]!.caption).toContain('Revised after your note: “deliver by 5 April”')
    w.sent.length = 0
    await react(w, ALEX, v1.waMessageIds[0]!, '👍')
    expect(w.sent).toEqual([])
    expect((await w.conn.store.getApproval(v1.id))!.status).toBe('sent_back')

    await text(w, ALEX, 'approve TSO/26-27/0002')
    expect((await w.conn.store.getApproval(v2.id))!).toMatchObject({ status: 'approved', via: 'text' })
    w.groupSend.fail = 'after'
    await later(w, 61_000)
    w.groupSend.fail = null
    for (let i = 0; i < 6; i += 1) await later(w, 30_000)
    expect(w.media.filter((row) => row.number === GROUP).length).toBe(1)
    const tasks = await w.conn.store.listTasks()
    expect(tasks.find((task) => task.title === 'Check whether TSO/26-27/0002 reached Northwind – Tierra')).toMatchObject({ assigneeName: 'Anju', kind: 'review' })
    expect(toAlex(w)).toContain('I could not confirm that TSO/26-27/0002 reached *Northwind – Tierra*. The office will check the group.')
    // nobody knows whether it reached the customer: approved, not sent
    expect((await w.conn.store.getSalesOrder(order.id))!.status).toBe('approved_unsent')
  })

  it('holds a failing PO, tasks the manager, rechecks after receipts and *done*, then raises the TSO', async () => {
    w.reading.value = { kind: 'po', po: poWith(333, '4400099997'), reader: 'llm' }
    await pdfFromAlex(w)
    expect(toAlex(w).at(-1)).toContain('Materials are short, so no sales order yet.')
    await later(w, 3_000)
    const po = (await w.conn.store.findCustomerPosByNumber('4400099997'))[0]!
    expect(po.status).toBe('short')
    expect(await w.conn.store.findSalesOrderForPo(po.id)).toBeNull()
    const hold = (await w.conn.store.listTasks()).find((task) => task.subjectId === po.id && task.kind === 'procurement')!
    expect(hold.title).toBe('Procure for PO 4400099997 (NW) — short ZPMLMN 27.15 kg, ZOILP 226.25 after incoming; expedite ZPMCN5, ZFLSALT')
    const notice = toJoshy(w).find((row) => row.text.includes('Procure for PO 4400099997'))!
    expect((await w.conn.store.listProcurementRequests({ subjectId: po.id })).map((row) => [row.reason, row.itemCode]).sort()).toEqual([
      ['expedite', 'ZFLSALT'],
      ['expedite', 'ZPMCN5'],
      ['shortage', 'ZOILP'],
      ['shortage', 'ZPMLMN'],
    ])

    // done too early: still short, the task opens again
    await text(w, JOSHY, 'done', notice.id)
    expect(toJoshy(w).at(-1)!.text).toContain('as done.')
    await later(w, 3_000)
    expect((await w.conn.store.getTask(hold.id))!.status).toBe('todo')
    expect(toJoshy(w).at(-1)!.text).toContain('PO 4400099997 is still short after the recheck, so the task is open again.')

    await text(w, JOSHY, 'received 30 kg ZPMLMN, 250 ZOILP')
    expect(toJoshy(w).at(-1)!.text).toContain('Recorded as received (unposted until the GRN is in SAP): 30 kg ZPMLMN, 250 ZOILP.')
    expect((await w.conn.store.listStockAdjustments()).map((row) => [row.itemCode, row.qty, row.taskId])).toEqual([
      ['ZOILP', 250, hold.id],
      ['ZPMLMN', 30, hold.id],
    ])
    w.media.length = 0
    await text(w, JOSHY, 'done', notice.id)
    await later(w, 3_000)
    const recheck = (await w.conn.store.latestInventoryCheck(po.id))!
    expect(recheck.verdict).toBe('pass_with_incoming')
    expect(recheck.lines.find((line) => line.itemCode === 'ZPMLMN')).toMatchObject({ adjustments: 30, status: 'ok' })
    await later(w, 3_000)
    expect((await w.conn.store.findSalesOrderForPo(po.id))!.docNo).toBe('TSO/26-27/0003')
    expect(w.media.filter((row) => row.number === ALEX).map((row) => row.fileName)).toEqual(['TSO-26-27-0003-v1.pdf', 'TSO-26-27-0003-v1-annex.pdf'])
  })

  it('records two copies of one PO arriving together as two revisions instead of failing a turn', async () => {
    w.reading.value = { kind: 'po', po: poWith(2, '4400099996'), reader: 'llm' }
    const message = (id: string) => {
      const parsed = parseWebhook(dm(id, ALEX, { documentMessage: { mimetype: 'application/pdf', fileName: 'PO.pdf' } }))
      if (parsed.type !== 'message') throw new Error('expected a message')
      return parsed.message
    }
    await Promise.all([handleIncoming(w.deps, message('race-1'), 'personal'), handleIncoming(w.deps, message('race-2'), 'personal')])
    expect((await w.conn.store.findCustomerPosByNumber('4400099996')).map((row) => [row.revision, row.status]).sort()).toEqual([
      [1, 'checked'],
      [2, 'awaiting_proceed'],
    ])
  })

  it('asks the customer instead of buying: a follow-up task and no request for the customer material', async () => {
    const w = await world('po_to_so_customer')
    try {
      await w.conn.sql`insert into item_owner_overrides (item_code, owner, owner_card_code) values ('ZPMLMN', 'customer', 'ZN05')`
      w.reading.value = { kind: 'po', po: poWith(290, '4400099995'), reader: 'llm' }
      await pdfFromAlex(w)
      await later(w, 3_000)
      const po = (await w.conn.store.findCustomerPosByNumber('4400099995'))[0]!
      const check = (await w.conn.store.latestInventoryCheck(po.id))!
      expect(check.verdict).toBe('fail')
      expect(check.lines.find((line) => line.itemCode === 'ZPMLMN')).toMatchObject({ owner: 'customer', status: 'short', shortAfterIncoming: 5.7 })
      const tasks = (await w.conn.store.listTasks()).filter((task) => task.subjectId === po.id)
      expect(tasks.find((task) => task.kind === 'customer_followup')).toMatchObject({
        title: 'Ask Northwind Kalamassery DC for ZPMLMN 5.7 kg (customer-supplied) — PO 4400099995',
        assigneeName: 'Joshy',
      })
      const requests = await w.conn.store.listProcurementRequests({ subjectId: po.id })
      expect(requests.some((row) => row.itemCode === 'ZPMLMN')).toBe(false)
    } finally {
      await w.conn.close()
    }
  })

  it('never raises a TSO it cannot tax: no GSTIN on the PO or the card sends the PO back to the office, every time', async () => {
    // a PO for a card SAP has no GSTIN for (an invented code), with no ship-to GSTIN on the PO either
    const po = await w.conn.store.createCustomerPo({
      partyGroupId: null, poNo: '4400099990', status: 'checked', cardCode: 'ZNOGST', siteCode: null, shipToGstin: null, shipToAddress: null,
      buyerName: 'Northwind Retail Limited', vendorCode: null, poDate: '2026-03-30', deliveryDate: '2026-04-05', basicTotal: 4200, taxTotal: 210,
      total: 4410, notes: [], reader: 'llm', resolution: null, reviewReason: null, repeatOf: [], documentId: null, sourceChat: null,
      sourceMessageId: null, sourceSender: 'Alex Thomas', raisedBy: 'usr_alex',
      lines: [{ ...poWith(1, 'x').lines[0]!, lineNo: 1, itemCode: 'ZFGN500', itemName: 'Zeta Banana Chips 500g', matchMethod: 'manual', matchConfirmed: true, pcs: 30, pcsSource: 'npu', pcsPerUom: 30, unitPrice: 140, note: null }],
    })
    const check = await w.conn.store.saveInventoryCheck({ customerPoId: po.id, kind: 'po', verdict: 'pass', dataAsOf: '2026-03-31', warnings: [], requested: [{ itemCode: 'ZFGN500', pcs: 30 }], createdBy: null, lines: [] })
    await processPo(w.deps, po.id, check.id)
    expect(await w.conn.store.findSalesOrderForPo(po.id)).toBeNull()
    const held = (await w.conn.store.getCustomerPo(po.id))!
    expect(held).toMatchObject({ status: 'needs_review' })
    expect(held.reviewReason).toBe('No sales order was raised: Neither the PO nor the SAP card has a GSTIN, so the place of supply (CGST + SGST or IGST) is unknown.')
    const review = (await w.conn.store.listTasks()).find((task) => task.subjectType === 'customer_po' && task.subjectId === po.id)!
    expect(review).toMatchObject({ kind: 'review', assigneeName: 'Anju', title: 'Review PO 4400099990: no sales order yet' })
    expect(toAlex(w).at(-1)).toBe('PO 4400099990: no sales order yet. Neither the PO nor the SAP card has a GSTIN, so the place of supply (CGST + SGST or IGST) is unknown. The office has a review task.')

    // the office marks it done without fixing anything and confirms: blocked again, and the same task opens again
    await w.conn.store.updateTaskStatus(review.id, 'done')
    await w.conn.store.updateCustomerPo(po.id, { status: 'checked' })
    await processPo(w.deps, po.id, check.id)
    expect(await w.conn.store.getTask(review.id)).toMatchObject({ status: 'todo', completedAt: null })
    expect((await w.conn.store.listTasks()).filter((task) => task.subjectId === po.id)).toHaveLength(1)
    expect(await w.conn.store.findSalesOrderForPo(po.id)).toBeNull()
  })

  it('links TSOs the office keyed into SAP (in_sap, no longer reserving) and absorbs receipts SAP now has', async () => {
    const tso = (await w.conn.store.findSalesOrderByNo('TSO/26-27/0001'))!
    expect(tso.status).toBe('sent')
    const reservedBefore = (await w.conn.store.stockOverlays(['ZPMLMN'])).ZPMLMN!.reserved
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date())
    await w.conn.sql.unsafe(`
      INSERT INTO sap.ordr (docentry, docnum, series, canceled, docstatus, docdate, docduedate, taxdate, cardcode, cardname, numatcard, shiptocode, vatsum, doctotal, createdate, createts, usersign, wddstatus) VALUES
        (120, 20, 10, 'N', 'O', '2026-04-02', '2026-04-05', '2026-04-02', 'ZN05', 'Northwind Kalamassery DC', '4400099999', 'SHIP', 2520, 52920, '2026-04-02', 101500, 5, 'Y');
      INSERT INTO sap.rdr1 (docentry, linenum, visorder, itemcode, dscription, quantity, openqty, price, linetotal, vatprcnt, taxcode, whscode, linestatus, targettype, trgetentry, unitmsr) VALUES
        (120, 0, 0, 'ZFGN500', 'Zeta Banana Chips 500g', 360, 360, 140, 50400, 5, 'GST@5', 'FG01', 'O', -1, NULL, 'Pcs');
      INSERT INTO sap.opdn (docentry, docnum, series, canceled, docstatus, docdate, cardcode, cardname, numatcard, doctotal, createdate, createts) VALUES
        (520, 20, 15, 'N', 'C', '${today}', 'ZV002', 'Gamma Packaging Co', 'INV-99', 9000, '${today}', 100000);
      INSERT INTO sap.pdn1 (docentry, linenum, visorder, basetype, baseentry, baseline, itemcode, dscription, quantity, unitmsr, price, linetotal, whscode) VALUES
        (520, 0, 0, -1, NULL, NULL, 'ZPMLMN', 'Laminate-Zeta Big', 30, 'Kg', 300, 9000, 'RM01');`)
    await w.conn.sql`select erp.refresh()`
    const [sapSo] = await w.conn.sql`select doc_no from erp.sales_orders where doc_entry = 120`
    const [grn] = await w.conn.sql`select doc_no from erp.grns where doc_entry = 520`

    const result = await syncWithSap(w.deps)
    expect(result.linked).toEqual([{ docNo: 'TSO/26-27/0001', sapDocNo: String(sapSo!.doc_no) }])
    expect(await w.conn.store.getSalesOrder(tso.id)).toMatchObject({ status: 'in_sap', sapDocEntry: 120, sapDocNo: String(sapSo!.doc_no) })
    // SAP's own SO commits those pieces now: the TSO's 3.96 kg of laminate is no longer held twice
    expect((await w.conn.store.stockOverlays(['ZPMLMN'])).ZPMLMN!.reserved).toBeCloseTo(reservedBefore - 3.96, 4)
    // the 30 kg of laminate recorded as received is in SAP now; the oil is not
    expect(result.absorbed).toEqual([expect.objectContaining({ itemCode: 'ZPMLMN', note: `In SAP on ${String(grn!.doc_no)} of ${today}.` })])
    const adjustments = await w.conn.store.listStockAdjustments()
    expect(adjustments.map((row) => [row.itemCode, row.status])).toEqual([
      ['ZOILP', 'active'],
      ['ZPMLMN', 'absorbed'],
    ])
    // a second pass changes nothing; an in_sap TSO cannot be cancelled here
    expect(await syncWithSap(w.deps)).toEqual({ linked: [], absorbed: [] })
    // fourteen days on with no GRN, the oil stops counting too
    const aged = await absorbStockAdjustments({ ...w.deps, now: () => new Date(Date.now() + 15 * 24 * 60 * 60_000) })
    expect(aged).toEqual([expect.objectContaining({ itemCode: 'ZOILP', note: 'No GRN in SAP after 14 days; no longer counted.' })])
  })
})

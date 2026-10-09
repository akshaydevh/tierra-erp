import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedIfEmpty } from '../db/seed'
import type { PublicUser } from '../db/types'
import { inlineEnqueue } from '../jobs/worker'
import { dataBrief } from '../queries/brief'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { FakeModel, callTool, say, useTools, type SeenRequest } from '../test/fake-llm'
import { loadSapFixture } from '../test/sap'
import type { EvolutionClient } from '../whatsapp/evolution'
import { parseWebhook, type IncomingMessage } from '../whatsapp/parse'
import type { AgentDeps } from './deps'
import { listDeskMessages, postDeskTurn } from './desk'
import { handleIncoming } from './handle-message'

// The agent end to end on the synthetic SAP fixture (every code and amount invented): the pre-resolver and the
// tools read the real erp views through the audience's scope. Alpha (ZC001, PAN AAACZ1234A, vendor twin ZV001)
// and Beta (ZC002) are the two customers; data date 2026-03-31, financial year 25-26.

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const GROUP = '120363999@g.us'
const ALEX_PHONE = '919900000000'
const alex: PublicUser = { id: 'usr_alex', email: 'alex.thomas@tierra.test', name: 'Alex Thomas', role: 'admin' }

function lastTool(request: SeenRequest): Record<string, any> {
  return JSON.parse(String(request.messages.at(-1)?.content ?? '{}')) as Record<string, any>
}

describe.skipIf(!pg)('Agent v2 on the synthetic SAP fixture', () => {
  let conn: Connection
  let deps: AgentDeps
  let llm: FakeModel
  let sent: Array<{ number: string; text: string }>

  beforeAll(async () => {
    const url = await pg!.createDatabase('agent_fixture')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await seedIfEmpty(conn.db, 'secret-pass')
    await conn.store.saveRelation({ userId: 'usr_alex', phoneNumber: ALEX_PHONE })
    const party = await conn.store.createPartyGroup({ name: 'Alpha Snacks', members: [{ kind: 'pan', value: 'AAACZ1234A' }] })
    await conn.store.saveWaGroup(GROUP, { subject: 'Alpha – Tierra', partyGroupId: party.id })
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
        sent.push({ number, text })
        return { messageId: `out-${sent.length}-${Date.now()}` }
      },
      sendReaction: async () => undefined,
      fetchAllGroups: async () => [],
    } as unknown as EvolutionClient
    deps = {
      store: conn.store,
      evolution,
      sapSql: conn.sql,
      readPurchaseOrder: async () => ({ kind: 'not_po', reason: 'not used here' }),
      dataBrief: () => dataBrief(conn.sql, conn.store),
      chatModel: llm.model,
      enqueue: async () => true,
      botMode: 'dedicated',
      now: () => new Date('2026-04-01T06:00:00Z'),
    }
    deps.enqueue = inlineEnqueue(deps)
  })

  async function ask(text: string): Promise<string> {
    const posted = await postDeskTurn(deps, alex, { text, pdf: null })
    expect(posted.ok).toBe(true)
    const { messages } = await listDeskMessages(deps, alex.id)
    return messages.at(-1)!.text
  }

  function groupMessage(id: string, text: string): IncomingMessage {
    const event = parseWebhook({
      event: 'messages.upsert',
      instance: 'tierra',
      data: { key: { id, remoteJid: GROUP, fromMe: false, participant: `${ALEX_PHONE}@s.whatsapp.net` }, message: { conversation: text } },
    })
    if (event.type !== 'message') throw new Error('expected a message')
    return event.message
  }

  describe('internal (Alex on the desk)', () => {
    it('resolves "SO 1" before the prompt and answers who approved it from approval_history', async () => {
      llm.script(useTools(callTool('approval_history', { doc_no: 'SO 1' })), (request) => {
        const row = lastTool(request).rows[0]
        return say(`${row.docNo} was approved by ${row.approver} at ${row.decidedAt}.`)
      })
      const reply = await ask('who approved SO 1?')
      expect(llm.requests[0]?.messages.at(-1)?.content).toContain(
        '"SO 1" = SO/25-26/1 (sales order, 2026-03-30, Alpha Snacks Pvt Ltd, ₹10,500)',
      )
      expect(reply).toBe('SO/25-26/1 was approved by TEST ADMIN at 2026-03-30T04:42:00.000Z.')
      expect(llm.system()).toContain('SAP data is as of 2026-03-31')
    })

    it('gives free stock from free_stock: on hand, committed and free', async () => {
      llm.script(useTools(callTool('free_stock', { item_code: 'ZFGA100' })), (request) => {
        const row = lastTool(request).rows[0]
        return say(`${row.itemCode}: ${row.onHand} on hand, ${row.committed} committed, ${row.free} free.`)
      })
      expect(await ask('how many ZFGA100 are free?')).toBe('ZFGA100: 300 on hand, 500 committed, -200 free.')
      expect(llm.requests[0]?.messages.at(-1)?.content).toContain('"ZFGA100" = item ZFGA100 (Zeta Banana Chips 100g)')
    })

    it('compares a production order with its BOM and flags placeholder BOM lines', async () => {
      llm.script(useTools(callTool('consumption_vs_bom', { doc_no: 'PR 1' })), say('ok'))
      await ask('what did PR 1 consume vs BOM?')
      const result = JSON.parse(llm.toolResults()[0]!) as { order: { docNo: string }; components: Array<Record<string, unknown>> }
      expect(result.order.docNo).toBe('PR/25-26/1')
      expect(result.components).toEqual([
        expect.objectContaining({ itemCode: 'ZRMBN', issuedQty: 100, bomQty: 0.1, bomPlaceholder: true }),
        expect.objectContaining({ itemCode: 'ZPMLMA', issuedQty: 8, bomQty: 8, varianceQty: 0 }),
        expect.objectContaining({ itemCode: 'ZPMCN', issuedQty: 20, bomQty: 20, varianceQty: 0 }),
      ])
    })

    it('sees every customer on a shared PO number and the SAP approval trail of an order', async () => {
      llm.script(
        useTools(callTool('customer_po_status', { customer_po_no: 'APO-7001' }), callTool('get_sales_order', { doc_no: 'SO/25-26/1' })),
        say('ok'),
      )
      await ask('status of APO-7001')
      const [status, order] = llm.toolResults().map((result) => JSON.parse(result) as Record<string, any>)
      expect(status!.salesOrders.map((row: { docNo: string }) => row.docNo)).toEqual(['SO/25-26/4', 'SO/25-26/3', 'SO/25-26/1'])
      expect(order!.approvals).toEqual([expect.objectContaining({ status: 'approved', approver: 'TEST ADMIN' })])
      // totals come from SQL over every row, so a cut list cannot change them
      expect(status!.totals).toMatchObject({ salesOrders: 3 })
      expect(status!.totals.value).toBe(status!.salesOrders.reduce((sum: number, row: { total: number; status: string }) => sum + (row.status === 'cancelled' ? 0 : row.total), 0))
      expect(order!.lineTotals).toMatchObject({ lines: order!.lines.length })
    })
  })

  describe('a customer group mapped to Alpha (party scope, even when Alex speaks)', () => {
    it("drops another customer's invoice from the prompt and never returns a Beta row", async () => {
      llm.script(
        useTools(
          callTool('get_invoice', { doc_no: 'TF/25-26/1' }),
          callTool('get_document', { doc_no: 'TF/25-26/1' }),
          callTool('find_invoices', {}),
          callTool('find_sales_orders', {}),
          callTool('customer_po_status', { customer_po_no: 'APO-7001' }),
          callTool('dispatches_on', { date: '2026-03-31' }),
          callTool('find_credit_notes', {}),
          callTool('get_document', { doc_no: 'GR/25-26/1' }),
          callTool('get_sales_order', { doc_no: 'SO/25-26/1' }),
        ),
        say('TF/25-26/1: not found for your account.'),
      )
      await handleIncoming(deps, groupMessage('g-leak', '@Tierra Bot TF/25-26/1'), 'group')

      const first = llm.requests[0]!
      expect(first.messages.at(-1)?.content).not.toContain('References found')
      expect(first.toolNames).not.toContain('free_stock')
      expect(llm.system()).toContain('WhatsApp group of the customer Alpha Snacks ("Alpha – Tierra")')
      const results = llm.toolResults().map((result) => JSON.parse(result) as Record<string, any>)
      const [invoice, document, invoices, orders, poStatus, dispatch, credits, grn, order] = results
      expect(invoice).toEqual({ found: false, message: 'Not found for your account.' })
      expect(document).toEqual({ found: false, message: 'Not found for your account.' })
      expect(invoices!.rows.map((row: { docNo: string }) => row.docNo)).toEqual(['TF/25-26/3'])
      expect(orders!.rows.map((row: { cardCode: string }) => row.cardCode)).toEqual(['ZC001', 'ZC001'])
      expect(poStatus!.salesOrders.map((row: { docNo: string }) => row.docNo)).toEqual(['SO/25-26/3', 'SO/25-26/1'])
      expect(dispatch!.rows.map((row: { docNo: string }) => row.docNo)).toEqual(['TF/25-26/3'])
      expect(credits).toEqual({ total: 0, totalValue: 0, rows: [] })
      // totals are summed in SQL within the party's cards
      expect(poStatus!.totals).toMatchObject({ salesOrders: 2 })
      // The vendor twin shares Alpha's PAN, but purchasing documents are never party-visible.
      expect(grn).toEqual({ found: false, message: 'Not found for your account.' })
      expect(order!.approvals).toBeUndefined()

      // Nothing about Beta reached the model: not its name, its card, its PO numbers or its invoice.
      const seen = llm.transcript()
      for (const leak of ['Beta', 'ZC002', 'BPO-', 'SO/25-26/2', 'SO/25-26/4', 'TF/25-26/4', 'CN/25-26/1']) {
        expect(seen, leak).not.toContain(leak)
      }
      expect(sent).toEqual([{ number: GROUP, text: expect.stringContaining('not found for your account') }])
    })

    it('resolves its own document numbers for the prompt', async () => {
      llm.script(say('ok'))
      await handleIncoming(deps, groupMessage('g-own', 'Tierra Bot, status of TF/25-26/3 and SO 1?'), 'group')
      const user = String(llm.requests[0]?.messages.at(-1)?.content)
      expect(user).toContain('"TF/25-26/3" = TF/25-26/3 (invoice, 2026-03-31, Alpha Snacks Pvt Ltd, ₹1,050)')
      expect(user).toContain('"SO 1" = SO/25-26/1 (sales order')
    })

    it('refuses an internal tool the model asks for anyway', async () => {
      llm.script(useTools(callTool('free_stock', { item_code: 'ZFGA100' })), say('I cannot share stock here.'))
      await handleIncoming(deps, groupMessage('g-stock', 'Tierra Bot how much ZFGA100 is free?'), 'group')
      expect(llm.toolResults()).toEqual([JSON.stringify({ error: 'The tool free_stock is not available here.' })])
      expect(llm.transcript()).not.toContain('"onHand"')
      expect(String(llm.requests[0]?.messages.at(-1)?.content)).not.toContain('= item ZFGA100')
    })
  })

  it('gives an unknown number no tools and no references', async () => {
    llm.script(say('A Tierra person will get back to you.'))
    const event = parseWebhook({
      event: 'messages.upsert',
      instance: 'tierra',
      data: { key: { id: 'dm-unknown', remoteJid: '919811111111@s.whatsapp.net', fromMe: false }, message: { conversation: 'status of TF/25-26/1 and SO 1?' } },
    })
    if (event.type !== 'message') throw new Error('expected a message')
    await handleIncoming(deps, event.message, 'personal')
    expect(llm.requests[0]?.toolNames).toEqual([])
    expect(String(llm.requests[0]?.messages.at(-1)?.content)).not.toContain('References found')
    expect(llm.transcript()).not.toContain('Beta')
  })
})

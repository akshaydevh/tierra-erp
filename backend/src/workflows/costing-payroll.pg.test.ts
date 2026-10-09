import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../app'
import { routeMessage } from '../agent/route'
import { seedIfEmpty } from '../db/seed'
import { dataBrief } from '../queries/brief'
import { costingKpis, materialMix, productionCost, productionCosts, skuMargins, stockValuation, wipVariance } from '../queries/costing'
import { attendanceMonth, headcount, leaveSummary, payrollSummary, peelingMonth, reconciliation } from '../queries/payroll'
import { FakeModel, callTool, say, useTools, type SeenRequest } from '../test/fake-llm'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { loadHrFixture, loadSapFixture } from '../test/sap'
import type { EvolutionClient } from '../whatsapp/evolution'
import type { IncomingMessage } from '../whatsapp/parse'

// P7 on the synthetic fixtures. SAP (data date 2026-03-31): production order 701 (PR/25-26/1) made 1,000 ZFGA100
// (100 g) from 5,000 of material; in March ZFGA100 sold 40 at 25 (SAP COGS 6 a piece) and ZFGB200 138.1 at 50 (not
// produced in March: SAP COGS 30). HR (test/hr-fixture.synthetic.sql): the February 2026 payrolls.

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const PHONES = { alex: '919900000011', joshy: '919900000012', anju: '919900000013' } as const
type Who = keyof typeof PHONES
const NOW = new Date('2026-04-03T06:00:00Z')
const NAMES = ['Asha Kumar', 'Bala Nair', 'Chitra Das', 'Dev Menon', 'Ela Temp', 'Fia Temp']

function toolResults(request: SeenRequest): Array<Record<string, any>> {
  return request.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content)) as Record<string, any>)
}

describe.skipIf(!pg)('costing and payroll (synthetic fixtures)', () => {
  let conn: Connection
  let url: string
  let deps: AppDeps
  let llm: FakeModel
  let texts: Array<{ to: string; text: string }>
  let seq = 0

  beforeAll(async () => {
    url = await pg!.createDatabase('costing_fixture')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await seedIfEmpty(conn.db, 'secret-pass')
    for (const [who, phone] of Object.entries(PHONES)) await conn.store.saveRelation({ userId: `usr_${who}`, phoneNumber: phone })
    await conn.sql`insert into party_aliases (card_code, alias) values ('ZC001', 'Alpha'), ('ZC002', 'Beta')`
  })

  afterAll(async () => {
    await conn?.close()
    await pg?.stop()
  })

  beforeEach(() => {
    llm = new FakeModel()
    texts = []
    const evolution = {
      sendText: async (to: string, text: string) => {
        texts.push({ to, text })
        return { messageId: `out-t-${++seq}` }
      },
      sendMedia: async () => ({ messageId: `out-m-${++seq}` }),
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
      now: () => NOW,
      webhookSecret: 'test-secret',
      sessionTtlMs: 60_000,
    }
  })

  async function send(text: string, who: Who): Promise<string> {
    seq += 1
    const message: IncomingMessage = {
      id: `in-${seq}-${Date.now()}`,
      remoteJid: `${PHONES[who]}@s.whatsapp.net`,
      fromMe: false,
      text,
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
    }
    await conn.store.claimMessage({ evolutionMessageId: message.id, remoteJid: message.remoteJid, fromMe: false, hasPdf: false, body: text, kind: 'text' })
    return (await routeMessage(deps, message, 'personal')) ?? ''
  }

  async function cookies() {
    const app = createApp(deps)
    const cookieFor = async (email: string) => {
      const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret-pass' }) })
      return `tierra_session=${login.headers.get('set-cookie')?.match(/tierra_session=([^;]+)/)?.[1]}`
    }
    const [alex, joshy, anju] = await Promise.all([cookieFor('alex.thomas@tierra.test'), cookieFor('joshy@tierra.test'), cookieFor('anju@tierra.test')])
    const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } })
    return { alex, joshy, anju, get }
  }

  it('costs production orders and sold pieces from SAP, material only', async () => {
    const order = await productionCost(conn.sql, { docNo: 'PR/25-26/1' })
    expect(order).toMatchObject({ itemCode: 'ZFGA100', producedQty: 1000, producedKg: 100, issuedValue: 5000, returnedValue: 0, materialCost: 5000, costPerPc: 5, costPerKg: 50 })
    expect(order?.breakdown).toEqual([
      { role: 'raw_banana', value: 4000 },
      { role: 'laminate', value: 800 },
      { role: 'carton', value: 200 },
    ])
    const march = await productionCosts(conn.sql, { from: '2026-03-01', to: '2026-03-31' })
    expect(march.rows.map((row) => row.docNo)).toEqual(['PR/25-26/1'])
    expect(march.totals).toMatchObject({ orders: 1, producedQty: 1000, producedKg: 100, materialCost: 5000, costPerKg: 50 })

    const bySku = await skuMargins(conn.sql, { from: '2026-03-01', to: '2026-03-01', by: 'sku' })
    expect(bySku.rows.map((row) => [row.itemCode, row.qty, row.revenue, row.materialCost, row.pricePerPc, row.costPerPc, row.cogsPerPc, row.cogsFallbackPct])).toEqual([
      ['ZFGB200', 138.1, 6904.76, 4143, 50, 30, 30, 100],
      ['ZFGA100', 40, 1000, 200, 25, 5, 6, 0],
    ])
    expect(bySku.totals).toMatchObject({ revenue: 7904.76, materialCost: 4343, margin: 3561.76, kg: 31.62 })
    const one = await skuMargins(conn.sql, { from: '2026-03-01', to: '2026-03-01', by: 'sku', itemCodes: ['ZFGA100'] })
    expect(one.rows[0]).toMatchObject({ marginPerPc: 20, marginPerKg: 200, marginPct: 80 })
    const byCustomer = await skuMargins(conn.sql, { from: '2026-03-01', to: '2026-03-01', by: 'customer' })
    expect(byCustomer.rows.map((row) => [row.name, row.revenue, row.pricePerPc])).toEqual([
      ['Beta Retail LLP', 6904.76, null],
      ['Alpha Snacks Pvt Ltd', 1000, null],
    ])
    // the cancelled invoice 202 and its mirror 203 are left out
    expect((await skuMargins(conn.sql, { from: '2026-03-01', to: '2026-03-01', by: 'sku', cardCodes: ['ZC001'] })).totals.qty).toBe(40)

    const { current, previous } = await costingKpis(conn.sql, '2026-03-01')
    expect(current).toMatchObject({ producedKg: 100, producedPcs: 1000, productionValue: 5000, materialCostPerKg: 50, soldKg: 31.62, revenue: 7904.76, materialCost: 4343, materialMargin: 3561.76, marginPerKg: 112.64 })
    expect(previous).toMatchObject({ month: '2026-02-01', producedKg: 0, materialCostPerKg: null, marginPerKg: null })

    expect(await materialMix(conn.sql, '2026-03-01', '2026-03-01')).toEqual([
      expect.objectContaining({ role: 'raw_banana', netValue: 4000, issuedKg: 100 }),
      expect.objectContaining({ role: 'laminate', netValue: 800 }),
      expect.objectContaining({ role: 'carton', netValue: 200 }),
    ])
    const valuation = await stockValuation(conn.sql)
    expect(valuation).toMatchObject({ total: 33500, glInventory: 33000, wipBalance: -120 })
    expect(valuation.rows.map((row) => [row.groupName, row.whsCode, row.method, row.value])).toEqual([
      ['Raw Banana', 'RM01', 'batch', 32000],
      ['Finished Goods', 'FG01', 'FIFO', 1500],
      ['Laminate', 'RM01', 'FIFO', 0],
    ])
    expect(await wipVariance(conn.sql, '2025-04-01', '2026-03-01')).toMatchObject({ rows: [{ month: '2026-03-01', net: 120 }], balance: 120 })
  })

  it('serves Costing to the manager and the admin, not the office', async () => {
    const { alex, joshy, anju, get } = await cookies()
    expect((await get('/api/costing', anju)).status).toBe(403)
    expect((await get('/api/costing/production/701', anju)).status).toBe(403)
    const page = (await (await get('/api/costing', joshy)).json()) as Record<string, any>
    expect(page).toMatchObject({ month: '2026-03-01', tab: 'skus', kpis: { current: { producedKg: 100, marginPerKg: 112.64 } }, wip: { balance: 120 } })
    expect(page.note).toContain('SAP has no labour or overhead cost')
    expect(page.margins.rows.map((row: any) => row.itemCode)).toEqual(['ZFGB200', 'ZFGA100'])
    const customers = (await (await get('/api/costing?tab=customers&month=2026-03', alex)).json()) as Record<string, any>
    expect(customers.margins.rows.map((row: any) => row.name)).toEqual(['Beta Retail LLP', 'Alpha Snacks Pvt Ltd'])
    const orders = (await (await get('/api/costing?tab=orders', alex)).json()) as Record<string, any>
    expect(orders.orders.rows.map((row: any) => [row.docNo, row.costPerPc])).toEqual([['PR/25-26/1', 5]])
    const mix = (await (await get('/api/costing?tab=mix&span=3', alex)).json()) as Record<string, any>
    expect(mix.from).toBe('2026-01-01')
    expect(mix.mix.map((row: any) => row.role)).toEqual(['raw_banana', 'laminate', 'carton'])
    expect(((await (await get('/api/costing?tab=valuation', alex)).json()) as Record<string, any>).valuation.total).toBe(33500)
    expect(((await (await get('/api/costing/production/701', joshy)).json()) as Record<string, any>).costPerPc).toBe(5)
    expect((await get('/api/costing/production/999', joshy)).status).toBe(404)
  })

  it('serves Payroll to the admin alone, and says when the HR files are not loaded', async () => {
    const { alex, joshy, anju, get } = await cookies()
    expect((await get('/api/payroll', alex)).status).toBe(503)
    expect((await get('/api/payroll', joshy)).status).toBe(403)
    await loadHrFixture(url)
    for (const cookie of [joshy, anju]) {
      const refused = await get('/api/payroll', cookie)
      expect(refused.status).toBe(403)
      expect(await refused.json()).toEqual({ error: 'Payroll is for the admin only' })
    }
    const page = (await (await get('/api/payroll', alex)).json()) as Record<string, any>
    expect(page.month).toBe('2026-02-01')
    expect(page.payroll.runs.map((run: any) => [run.source, run.headcount, run.net])).toEqual([
      ['voyon', 3, 61110],
      ['register', 3, 59200],
      ['temp_sheet', 2, 19207],
    ])
    expect(page.payroll.runs[1].categories.map((cat: any) => [cat.label, cat.people, cat.net])).toEqual([
      ['Office & Admin', 1, 29000],
      ['Peeling', 1, 20200],
      ['Sales Promotion', 1, 10000],
    ])
    expect(page.headcount).toMatchObject({ total: 4, voyonMaster: 3, onVoyonPayroll: 3, registerOnly: 1 })
    expect(page.attendance.codes).toEqual({ P: 5, 'W/OFF': 1, LWP: 1, CL: 1, Offday: 1 })
    expect(page.attendance.rows).toHaveLength(3)
    expect(page.peeling).toMatchObject({ totalKg: 640, totalIncentive: 320 })
    expect(page.peeling.leaderboard[0]).toMatchObject({ name: 'Bala Nair', kg: 380, days: 2, incentive: 200 })
    expect(page.leave).toMatchObject({ count: 3, byType: [{ leaveType: 'Unpaid Leave', requests: 2 }, { leaveType: 'Casual Leave', requests: 1 }] })
    expect(page.reconciliation).toMatchObject({ journalTotal: 80000, payroll: { voyonNet: 61110, registerEarned: 62000, tempNet: 19207 }, paidNextMonth: 0 })
  })

  it('reads the HR schema: aggregates unless names are asked for', async () => {
    const summary = await payrollSummary(conn.sql, '2026-02-01')
    expect(summary.people).toBeUndefined()
    expect(JSON.stringify(summary)).not.toMatch(/Asha|Bala|Chitra/)
    expect((await payrollSummary(conn.sql, '2026-02-01', { names: true })).people).toHaveLength(8)
    expect((await attendanceMonth(conn.sql, '2026-02-01', { date: '2026-02-03' })).perDay).toEqual([{ date: '2026-02-03', present: 2, leave: 0, lwp: 1, off: 0 }])
    expect((await peelingMonth(conn.sql, '2026-02-01')).leaderboard).toBeUndefined()
    expect((await leaveSummary(conn.sql, { from: '2026-02-01', to: '2026-02-28' })).count).toBe(2)
    expect((await headcount(conn.sql)).temps).toEqual([
      { block: 'sales_promotion_temp', label: 'Temporary sales promotion', people: 1 },
      { block: 'temporary', label: 'Temporary (factory)', people: 1 },
    ])
    expect((await reconciliation(conn.sql, '2026-02-01')).journal).toEqual([
      { account: 'Salary and allowances -Others', amount: 50000 },
      { account: 'Salary and allowances -Office', amount: 30000 },
    ])
  })

  it('answers "payroll Feb" on WhatsApp with category totals for the admin and a no for everyone else, without the model', async () => {
    const reply = await send('Payroll Feb', 'alex')
    expect(reply).toContain('*Payroll February 2026*')
    expect(reply).toContain('*Voyon payroll*: 3 people, net *₹61,110*')
    expect(reply).toContain('• Office & Admin: 1, ₹29,000')
    expect(reply).toContain('*Temporary workers*: 2, net *₹19,207*')
    expect(reply).toContain('SAP: salary journal ₹80,000')
    for (const name of NAMES) expect(reply).not.toContain(name)
    expect(await send('payroll June', 'alex')).toContain('No payroll on file for June 2025. On file: February 2026.')

    for (const who of ['joshy', 'anju'] as const) {
      expect(await send('Payroll Feb', who)).toContain('Payroll, attendance and leave are for the admin only.')
      expect(await send('salary of TF902?', who)).toContain('for the admin only')
      expect(await send('who was absent on 3 Feb', who)).toContain('for the admin only')
    }
    expect(llm.requests).toHaveLength(0)
  })

  it('gives the admin names only when the message asks, whatever the model passes', async () => {
    llm.script(useTools(callTool('payroll_summary', { month: 'Feb', names: true })), say('ok'))
    await send('how did the February payroll look?', 'alex')
    let [result] = toolResults(llm.last()!)
    expect(result!.payrolls.map((run: any) => [run.source, run.people, run.net])).toEqual([
      ['Voyon payroll', 3, 61110],
      ['Salary register', 3, 59200],
      ['Temporary wages sheet', 2, 19207],
    ])
    expect(result!.people).toBeUndefined()
    expect(result!.namesWithheld).toContain('only given when the admin asks')
    expect(result!.sap).toEqual({ salaryJournal: 80000, employerPfEsi: 0, salaryPaymentsNextMonth: 0 })
    for (const name of NAMES) expect(llm.transcript()).not.toContain(name)

    llm.script(useTools(callTool('payroll_summary', { employee: 'TF902' })), say('ok'))
    await send('what was the total payroll?', 'alex')
    ;[result] = toolResults(llm.last()!)
    expect(result).toEqual({ error: expect.stringContaining('only given when the admin asks') })

    llm.script(useTools(callTool('payroll_summary', { employee: 'TF902', month: '2026-02' })), say('ok'))
    await send('salary of TF902 in February', 'alex')
    ;[result] = toolResults(llm.last()!)
    expect(result!.person).toMatchObject({ name: 'Bala Nair', voyonCode: 'TF902', registerCode: 'TFL902' })
    expect(llm.user()).not.toContain('References found')
    expect(result!.pay.map((line: any) => [line.source, line.net, line.incentives])).toEqual([
      ['register', 20200, 4000],
      ['voyon', 20200, 4000],
    ])

    llm.script(useTools(callTool('attendance', { date: '2026-02-03', names: true }), callTool('leave_requests', { month: 'Feb' })), say('ok'))
    await send('who was absent on 3 Feb, and the leave in Feb?', 'alex')
    const [attendance, leave] = toolResults(llm.last()!)
    expect(attendance).toMatchObject({ people: 3, codes: { P: 2, LWP: 1 }, namesByCode: { LWP: ['Bala Nair'] } })
    expect(leave).toMatchObject({ count: 2, byStatus: [{ status: 'Approved', requests: 2 }] })
    expect(leave!.rows).toBeUndefined()
  })

  it('answers costing questions through the manager’s tools and keeps them from the office', async () => {
    llm.script(
      useTools(callTool('sku_margin', { item: 'ZFGA100', from_month: 'March' }), callTool('production_cost', { doc_no: 'PR 1' })),
      say('ok'),
    )
    await send('Margin on ZFGA100 since March, and what did PR 1 cost?', 'joshy')
    const [margin, cost] = toolResults(llm.last()!)
    expect(margin).toMatchObject({ period: 'March 2026', by: 'sku', count: 1 })
    expect(margin!.rows[0]).toMatchObject({ itemCode: 'ZFGA100', pricePerPc: 25, costPerPc: 5, cogsPerPc: 6, marginPerPc: 20 })
    expect(margin!.note).toContain('Material cost only')
    expect(cost).toMatchObject({ found: true, docNo: 'PR/25-26/1', materialCost: 5000, costPerPc: 5, costPerKg: 50 })

    llm.script(useTools(callTool('sku_margin', { party: 'Beta', by: 'customer' })), say('ok'))
    await send('margin on Beta this month', 'alex')
    expect(toolResults(llm.last()!)[0]!.rows.map((row: any) => [row.name, row.revenue])).toEqual([['Beta Retail LLP', 6904.76]])

    llm.script(useTools(callTool('production_cost', { doc_no: 'PR 1' })), say('That is for the manager.'))
    await send('what did PR 1 cost?', 'anju')
    expect(llm.last()!.toolNames).not.toContain('production_cost')
    expect(toolResults(llm.last()!)[0]).toEqual({ error: 'The tool production_cost is not available here.' })
    expect(llm.system()).toContain('costing and margins')
    expect(llm.system()).toContain('Payroll, attendance and leave are for the admin only')
  })
})

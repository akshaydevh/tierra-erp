import pdfParse from 'pdf-parse'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../app'
import { routeMessage } from '../agent/route'
import { seedIfEmpty } from '../db/seed'
import { buildDailyReport } from '../domain/daily-report'
import { renderDailyReportPdf } from '../pdf/daily-report'
import { masterTools } from '../agent/tools/masters'
import { productionTools } from '../agent/tools/production'
import type { ToolContext } from '../agent/tools/types'
import { dataBrief } from '../queries/brief'
import { ageingGroups, bankPositions, cardBalances, financeKpis, outwardsFor, paymentRequests, payments, paymentsByPurpose } from '../queries/finance'
import { FakeModel, callTool, say, useTools, type SeenRequest } from '../test/fake-llm'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { loadSapFixture } from '../test/sap'
import type { EvolutionClient, MediaMessage } from '../whatsapp/evolution'
import type { IncomingMessage } from '../whatsapp/parse'

// P6 on the synthetic fixture (data date 2026-03-31): bank ZETA (house bank, ZBANK1) opens at 10,000 and on 31-Mar
// takes 5,000 from Alpha, pays gas 1,200, repairs 800 (to "suresh"), 10,000 to Gamma and moves 3,000 to OMEGA
// (ZBANK2); OMEGA also has a 1.10 misc-income receipt dated 30-Mar, moved to 31-Mar by a re-attribution. Invoices
// 201 (Beta 5,250, keyed 14:30) and 204 (Alpha 1,050, keyed 16:00) are dated 31-Mar, 205 (Beta 2,000) 05-Mar.

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const PHONES = { alex: '919900000001', joshy: '919900000002', anju: '919900000003' } as const
type Who = keyof typeof PHONES
const NOW = new Date('2026-04-03T06:00:00Z')

function lastTool(request: SeenRequest): Record<string, any> {
  return JSON.parse(String(request.messages.at(-1)?.content ?? '{}')) as Record<string, any>
}

describe.skipIf(!pg)('daily report and finance (synthetic fixture)', () => {
  let conn: Connection
  let deps: AppDeps
  let llm: FakeModel
  let media: MediaMessage[]
  let texts: Array<{ to: string; text: string }>
  let seq = 0

  beforeAll(async () => {
    const url = await pg!.createDatabase('finance_fixture')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await seedIfEmpty(conn.db, 'secret-pass')
    for (const [who, phone] of Object.entries(PHONES)) await conn.store.saveRelation({ userId: `usr_${who}`, phoneNumber: phone })
    await conn.sql`insert into party_aliases (card_code, alias) values ('ZC001', 'Alpha'), ('ZC002', 'Beta')`
    await conn.sql`insert into gl_labels (gl_code, label, prefer_payee) values ('ZGAS', 'Gas', false), ('ZREP', 'Repairs', true)`
    await conn.sql`insert into bank_line_reattributions (trans_id, line_id, report_date, note) values (9006, 0, '2026-03-31', 'on the statement of the 31st')`
  })

  afterAll(async () => {
    await conn?.close()
    await pg?.stop()
  })

  beforeEach(async () => {
    llm = new FakeModel()
    media = []
    texts = []
    await conn.sql`delete from app_settings`
    const evolution = {
      sendText: async (to: string, text: string) => {
        texts.push({ to, text })
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

  function incoming(text: string, who: Who, quotedText: string | null = null): IncomingMessage {
    seq += 1
    return {
      id: `in-${seq}-${Date.now()}`,
      remoteJid: `${PHONES[who]}@s.whatsapp.net`,
      fromMe: false,
      text,
      quotedText,
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
  }

  async function send(text: string, who: Who, quotedText: string | null = null): Promise<string> {
    const message = incoming(text, who, quotedText)
    await conn.store.claimMessage({ evolutionMessageId: message.id, remoteJid: message.remoteJid, fromMe: false, hasPdf: false, body: text, kind: 'text' })
    return (await routeMessage(deps, message, 'personal')) ?? ''
  }

  it('builds the day from SAP: banks, labelled lines, a moved line, outwards and the month to date', async () => {
    const report = await buildDailyReport(deps, { date: '2026-03-31' })
    expect(report.kind).toBe('full')
    expect(report.basis).toBe('created_window')
    expect(report.banks).toEqual([
      { glCode: 'ZBANK1', bank: 'ZETA', houseBank: true, opening: 10000, receipts: 5000, payments: 15000, closing: 0 },
      { glCode: 'ZBANK2', bank: 'OMEGA', houseBank: false, opening: 0, receipts: 3001.1, payments: 0, closing: 3001.1 },
    ])
    expect(report.receipts.map((line) => [line.label, line.bank, line.amount, line.movedFrom])).toEqual([
      ['Misc Income', 'OMEGA', 1.1, '2026-03-30'],
      ['Alpha', 'ZETA', 5000, null],
      ['Transfer ⇄ ZETA', 'OMEGA', 3000, null],
    ])
    expect(report.payments.map((line) => [line.label, line.amount, line.ref])).toEqual([
      ['Transfer ⇄ OMEGA', 3000, 'RT 12'],
      ['Gas', 1200, 'PA 21'],
      ['Suresh', 800, 'PA 22'],
      ['Gamma Packaging', 10000, 'PA 23'],
    ])
    expect(report.outwards).toEqual({
      rows: [
        { label: 'Beta', amount: 5250, invoices: ['TF/25-26/1'], cardCodes: ['ZC002'] },
        { label: 'Alpha', amount: 1050, invoices: ['TF/25-26/3'], cardCodes: ['ZC001'] },
      ],
      total: 6300,
      monthToDate: 8300,
      monthLabel: 'Mar 2026',
    })
    expect(report.activity.production).toMatchObject({ value: false, source: 'sap' })
    expect(report.manpower).toEqual({ values: null, total: null })
    expect(report.missing).toEqual(['manpower'])
    expect(report.footnotes.join('\n')).toContain('* Misc Income ₹1.10 (OMEGA, RT 13) is dated 30-03-2026 in SAP and counted on this day.')
    expect(report.footnotes.join('\n')).toContain('Manpower not entered')
    expect(report.knownDifferences.length).toBeGreaterThan(0)

    // the balance follows the moved line: OMEGA opened the 31st without it, and the 30th closes without it
    expect((await bankPositions(conn.sql, '2026-03-30', [{ transId: 9006, lineId: 0, reportDate: '2026-03-31' }])).find((row) => row.bank === 'OMEGA')?.closing).toBe(0)
    expect((await bankPositions(conn.sql, '2026-03-30')).find((row) => row.bank === 'OMEGA')?.closing).toBe(1.1)
  })

  it('leaves a payment cancelled the same day out and lists a later cancellation in its column, so lists add up to the banks', async () => {
    const sum = (lines: Array<{ bank: string; amount: number }>, bank: string) =>
      Math.round(lines.filter((line) => line.bank === bank).reduce((total, line) => total + line.amount, 0) * 100) / 100
    for (const date of ['2026-03-29', '2026-03-30', '2026-03-31']) {
      const report = await buildDailyReport(deps, { date })
      for (const bank of report.banks) {
        expect([date, bank.bank, sum(report.receipts, bank.bank), sum(report.payments, bank.bank)]).toEqual([date, bank.bank, bank.receipts, bank.payments])
      }
    }
    expect((await buildDailyReport(deps, { date: '2026-03-29' })).receipts.map((line) => [line.label, line.amount])).toEqual([['Alpha', 2000]])
    const cancelledLater = await buildDailyReport(deps, { date: '2026-03-30' })
    expect(cancelledLater.receipts.map((line) => [line.label, line.bank, line.amount, line.ref])).toEqual([['cancelled Alpha', 'ZETA', -2000, 'RT 14']])
    expect(cancelledLater.payments).toEqual([])
    const sameDay = await buildDailyReport(deps, { date: '2026-03-31' })
    expect(sameDay.payments.map((line) => line.ref)).not.toContain('PA 25')
    expect(sameDay.banks.find((bank) => bank.bank === 'ZETA')).toMatchObject({ payments: 15000, closing: 0 })
  })

  it('never ages a cancelled receipt or its reversal', async () => {
    const rows = await conn.sql`select trans_id, amount from erp.ar_ap_ageing where card_code = 'ZC001' order by trans_id`
    expect(rows.map((row) => [row.trans_id, Number(row.amount)])).toEqual([
      [9102, 1050],
      [9104, 5000],
    ])
  })

  it('switches the outwards basis and the cut-off', async () => {
    await conn.store.saveSetting('daily_report.cutoff', '15:00', null)
    const cut = await buildDailyReport(deps, { date: '2026-03-31' })
    expect([cut.outwards.total, cut.outwards.monthToDate]).toEqual([5250, 7250])
    expect(cut.footnotes[0]).toContain('after 15:00 on 30-03-2026 and up to 15:00 on 31-03-2026')
    const byDate = await buildDailyReport(deps, { date: '2026-03-31', basis: 'doc_date' })
    expect([byDate.outwards.total, byDate.outwards.monthToDate]).toEqual([6300, 8300])
    const byEwb = await buildDailyReport(deps, { date: '2026-03-31', basis: 'ewb_date' })
    expect(byEwb.outwards.rows.map((row) => row.label)).toEqual(['Beta', 'Alpha'])
    await conn.store.saveSetting('daily_report.outwards_basis', 'doc_date', null)
    expect((await buildDailyReport(deps, { date: '2026-03-05' })).outwards).toMatchObject({ total: 2000, monthToDate: 2000 })
  })

  it("keeps the manual sheet's month total when an invoice dated last month is keyed after the cut-off", async () => {
    // with a 15:00 cut-off, invoice 204 (dated 31-Mar, keyed 16:00) goes out in the window of 1-Apr
    const march = await outwardsFor(conn.sql, { date: '2026-03-31', basis: 'created_window', cutoff: '15:00' })
    expect([march.invoices.map((row) => row.docEntry), march.monthToDate]).toEqual([[201], 7250])
    // it is in 1-Apr's day total, but April's month total only has invoices dated in April
    const april = await outwardsFor(conn.sql, { date: '2026-04-01', basis: 'created_window', cutoff: '15:00' })
    expect([april.invoices.map((row) => row.docEntry), april.monthToDate]).toEqual([[204], 0])
    expect((await outwardsFor(conn.sql, { date: '2026-04-01', basis: 'doc_date' })).monthToDate).toBe(0)
  })

  it('prints the estimate beside SAP kg, and only the inputs after the data date', async () => {
    await conn.store.saveDailyInputs('2026-03-22', { bananaKgEstimate: 1200, inwardRemarks: { banana: 'gate scale' } }, { userId: 'usr_anju', at: NOW })
    const inwards = await buildDailyReport(deps, { date: '2026-03-22' })
    expect(inwards.inwards.find((row) => row.key === 'banana')).toMatchObject({ quantity: '1.2 t (SAP GRPO 800 kg)', remarks: 'gate scale', grns: ['GR/25-26/2'] })
    expect(inwards.inwards.find((row) => row.key === 'packing')?.quantity).toBe('400 nos')

    const later = await buildDailyReport(deps, { date: '2026-04-02' })
    expect(later.kind).toBe('inputs_only')
    expect(later.banks).toEqual([])
    expect(later.footnotes[0]).toBe('SAP data ends 31 Mar 2026: bank, outwards and inwards are not in SAP yet for 2 Apr 2026.')
  })

  it('renders the PDF like the sheet', async () => {
    const pdf = await renderDailyReportPdf(await buildDailyReport(deps, { date: '2026-03-31' }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const { text, numpages } = await pdfParse(pdf)
    expect(numpages).toBe(1)
    for (const expected of ['DAILY REPORT', '31-03-2026', 'Bank opening balance', 'Bank closing balance', 'Transfer from ZETA', 'Transfer to OMEGA', 'Suresh', '6,300.00', '8,300.00', 'Manpower not entered', 'Known differences vs manual sheet']) {
      expect(text).toContain(expected)
    }
  })

  it('takes manpower and the banana estimate from the office, refuses finance to it, and sends the PDF to the admin', async () => {
    expect(await send('manpower 7 6 6 7 19 25 2 13 for 31/3', 'anju')).toContain('Saved for 31 Mar 2026 — reply with a date to change.\nManpower total *85*')
    expect((await conn.store.getDailyInputs('2026-03-31'))?.manpower).toMatchObject({ office: 7, temporary: 13 })
    expect(await send('manpower 7 6 6', 'anju')).toContain('That is 3 numbers.')
    expect(await send('manpower 1 1 1 1 1 1 1 1 for 31/3', 'joshy')).toContain('Only the office (QA) or the admin')
    expect(await send('banana 1.2t for 22/3', 'anju')).toContain('Saved for 22 Mar 2026 — reply with a date to change.\nBanana *1.2 t* (SAP GRPO 800 kg)')
    expect(await send('SBI balance?', 'anju')).toContain('are for the manager and the admin')
    expect(await send('daily report 31/3', 'anju')).toContain('are for the manager and the admin')
    expect(llm.requests).toHaveLength(0)
    expect(media).toHaveLength(0)

    const caption = await send('daily report 31/3', 'alex')
    expect(media).toHaveLength(1)
    expect(media[0]).toMatchObject({ number: PHONES.alex, mediatype: 'document', mimetype: 'application/pdf', fileName: 'daily-report-2026-03-31.pdf' })
    expect(caption).toContain('Daily report 31 Mar 2026')
    expect(caption).toContain('Manpower 85.')
    expect((await pdfParse(Buffer.from(media[0]!.media, 'base64'))).text).toContain('85')
    const stored = await conn.store.latestDailyReport('2026-03-31')
    expect(stored).toMatchObject({ version: 1, basis: 'created_window', dataAsOf: '2026-03-31', generatedBy: 'usr_alex' })
    expect((await conn.store.findMessage('out-m-' + String(seq)))?.purpose).toBe('daily_report')

    await send('report for 2 Apr', 'alex')
    expect(media.at(-1)?.fileName).toBe('daily-report-2026-04-02.pdf')
    expect(media.at(-1)?.caption).toContain('SAP data ends 31 Mar 2026; sending the inputs-only page.')
    expect(llm.requests).toHaveLength(0)
  })

  it('answers finance questions through the manager’s tools and keeps them from the office', async () => {
    llm.script(
      useTools(callTool('bank_position', { date: '2026-03-31' }), callTool('pending_payment_approvals', {})),
      (seen) => say(`ZETA closed at ${lastTool(seen).count}`),
    )
    await send('bank position and pending approvals?', 'joshy')
    const tools = llm.requests[1]!.messages.filter((message) => message.role === 'tool').map((message) => JSON.parse(String(message.content)))
    expect(tools[0].accounts.map((row: any) => [row.bank, row.closing])).toEqual([
      ['ZETA', 0],
      ['OMEGA', 3001.1],
    ])
    expect(tools[0].lines.map((line: any) => line.label)).toContain('Suresh')
    expect(tools[1]).toMatchObject({ count: 1, amount: 2500 })

    llm.script(
      useTools(callTool('party_balance', { party: 'Alpha' }), callTool('ageing', { side: 'receivable' }), callTool('payments', { direction: 'out', text: 'gas' })),
      say('ok'),
    )
    await send('how much does Alpha owe, the ageing, and gas payments', 'joshy')
    const [balance, ageing, gas] = llm.requests.at(-1)!.messages.filter((message) => message.role === 'tool').slice(-3).map((message) => JSON.parse(String(message.content)))
    expect(balance.customerNet).toBe(6050)
    expect(balance.cards.find((row: any) => row.cardCode === 'ZC001')).toMatchObject({ owed: 6050, over90: 5000 })
    expect(ageing.totals).toMatchObject({ not_due: 6300, '1_30': 1475, '91_180': 5000, net: 12775 })
    expect(gas).toMatchObject({ count: 1, amount: 1200 })

    llm.script(useTools(callTool('find_journal_entries', { text: 'Alpha' })), say('ok'))
    await send('find the JE for the Alpha opening invoice', 'alex')
    expect(lastTool(llm.requests.at(-1)!).rows.map((row: any) => row.docNo)).toEqual(['JV/25-26/11', 'JV/25-26/15', 'JV/25-26/14', 'JV/25-26/2'])

    llm.script(useTools(callTool('bank_position', {})), say('That is for the manager.'))
    expect(await send('what is the cash position in our accounts?', 'anju')).toContain('are for the manager and the admin')
    await send('how much did we pay Gamma this month?', 'anju')
    expect(llm.requests.at(-1)!.toolNames).not.toContain('bank_position')
    expect(lastTool(llm.requests.at(-1)!)).toEqual({ error: 'The tool bank_position is not available here.' })
    expect(llm.requests.at(-1)!.messages[0]!.content).toContain('Finance (bank balances, payments, receivables, payables, journal entries, costing and margins, and the daily report) is for the manager and the admin')
  })

  it('saves inputs without a day for yesterday before noon, names the day, and moves them on a reply with a day', async () => {
    // NOW is 11:30 in India on 3-Apr: the inputs are for 2-Apr
    const saved = await send('cassava 2.5 t', 'anju')
    expect(saved).toContain('Saved for 2 Apr 2026 — reply with a date to change.\nCassava *2.5 t* (no GRPO in SAP for that day yet)')
    expect((await conn.store.getDailyInputs('2026-04-02'))?.cassavaKgEstimate).toBe(2500)
    const moved = await send('1/4', 'anju', saved)
    expect(moved).toContain('Saved for 1 Apr 2026 — reply with a date to change.\nCassava *2.5 t* moved from 2 Apr 2026.')
    expect((await conn.store.getDailyInputs('2026-04-01'))?.cassavaKgEstimate).toBe(2500)
    expect((await conn.store.getDailyInputs('2026-04-02'))?.cassavaKgEstimate).toBeNull()
    expect(await send('1/4', 'joshy', moved)).toContain('Only the office (QA) or the admin')
    expect(llm.requests).toHaveLength(0)
  })

  it('sends the report from the tool loop and saves inputs the office typed', async () => {
    llm.script(useTools(callTool('daily_report', { date: '31 March' })), (seen) => say(`Sending; outwards ${lastTool(seen).outwards.total}`))
    await send('can you send me the report of the last day of March?', 'alex')
    expect(texts.at(-1)?.text).toContain('Sending; outwards 6300')
    expect(media.at(-1)).toMatchObject({ fileName: 'daily-report-2026-03-31.pdf' })

    llm.script(useTools(callTool('set_daily_inputs', { date: '2026-03-30', banana_kg: 9000, packing: true })), say('Saved.'))
    await send('for 30 March: banana came 9 tonnes and packing ran', 'anju')
    expect(await conn.store.getDailyInputs('2026-03-30')).toMatchObject({ bananaKgEstimate: 9000, packingRun: true, enteredBy: 'usr_anju' })

    llm.script(useTools(callTool('set_daily_inputs', { date: '2026-03-29', banana_kg: 5000 })), say('Saved.'))
    await send('put the usual banana figure for 29 March', 'anju')
    expect(await conn.store.getDailyInputs('2026-03-29')).toBeNull()
    expect(texts.at(-1)?.text).toContain('I have not saved those daily report figures.')
  })

  it('serves the Payments page and the Reports API by role', async () => {
    const app = createApp(deps)
    const cookieFor = async (email: string) => {
      const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret-pass' }) })
      return `tierra_session=${login.headers.get('set-cookie')?.match(/tierra_session=([^;]+)/)?.[1]}`
    }
    const [alex, joshy, anju] = await Promise.all([cookieFor('alex.thomas@tierra.test'), cookieFor('joshy@tierra.test'), cookieFor('anju@tierra.test')])
    const get = (path: string, cookie: string) => app.request(path, { headers: { cookie } })
    const json = async (response: Response) => (await response.json()) as Record<string, any>

    expect((await get('/api/payments', anju)).status).toBe(403)
    const bank = await json(await get('/api/payments', joshy))
    expect(bank.kpis).toMatchObject({ cash: 3001.1, receiptsMtd: 5001.1, paymentsMtd: 12000, pendingApprovals: { count: 1, amount: 2500 }, netReceivable: 12775, netPayable: 26000 })
    expect(bank.bank.account.shortName).toBe('ZETA')
    // the cancelled receipt (29-Mar, reversed 30-Mar) and payment (31-Mar, reversed the same day) stay in the bank book
    expect(bank.bank.rows.map((row: any) => row.balance)).toEqual([10000, 12000, 10000, 15000, 13800, 13000, 10000, 0, -700, 0])
    expect(bank.bank).toMatchObject({ opening: 0, receipts: 15000, payments: 15000, closing: 0 })
    const lastDay = await json(await get('/api/payments?tab=bank&bank=ZBANK1&from=2026-03-31&to=2026-03-31', joshy))
    expect(lastDay.bank).toMatchObject({ opening: 10000, receipts: 5000, payments: 15000, closing: 0, total: 7 })
    const receivables = await json(await get('/api/payments?tab=receivables&group=AAACZ1234A', joshy))
    expect(receivables.ageing.rows.map((row: any) => [row.name, row.net, row.overdue])).toEqual([
      ['Beta Retail LLP', 6725, 1475],
      ['Alpha Snacks Pvt Ltd', 6050, 5000],
    ])
    expect(receivables.cards.map((row: any) => row.cardCode)).toEqual(['ZC001'])
    const purposes = await json(await get('/api/payments?tab=purposes&purpose=ZGAS', joshy))
    expect(purposes.purposes.rows.map((row: any) => [row.label, row.amount])).toEqual([
      ['Suppliers', 10000],
      ['Industrial Gas Expenses', 1200],
      ['Repairs & Maintenance-Others', 800],
    ])
    expect(purposes.list.rows.map((row: any) => row.docNo)).toEqual(['PA/25-26/21'])
    const approvals = await json(await get('/api/payments?tab=approvals', alex))
    expect(approvals.requests.rows.map((row: any) => [row.amount, row.memo])).toEqual([[2500, 'Banana unloading charge']])

    expect((await json(await get('/api/reports', anju)))).toMatchObject({ canSeeReport: false, canEditInputs: true, canChangeBasis: false, defaultDate: '2026-03-31' })
    expect((await get('/api/reports/daily/2026-03-31', anju)).status).toBe(403)
    const preview = await json(await get('/api/reports/daily/2026-03-31', joshy))
    expect(preview.payload.outwards.total).toBe(6300)
    const pdf = await get('/api/reports/daily/2026-03-31.pdf', joshy)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(Buffer.from(await pdf.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-')

    const put = (cookie: string, body: unknown) =>
      app.request('/api/reports/daily-inputs/2026-03-28', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect((await put(joshy, { notes: 'x' })).status).toBe(403)
    expect((await put(anju, { manpower: { office: 1 } })).status).toBe(400)
    const saved = await json(await put(anju, { productionRun: false, notes: 'Boiler down', manpower: { office: 7, qc: 6, operators: 6, gents_unloading: 7, ladies: 19, temp_ladies: 25, security: 2, temporary: 13 } }))
    expect(saved.inputs).toMatchObject({ productionRun: false, notes: 'Boiler down', enteredByName: 'Anju' })
    expect((await json(await get('/api/reports/daily-inputs/2026-03-28', joshy))).inputs.notes).toBe('Boiler down')

    const basis = (cookie: string, outwardsBasis: string) =>
      app.request('/api/reports/settings', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ outwardsBasis }) })
    expect((await basis(joshy, 'doc_date')).status).toBe(403)
    expect((await basis(alex, 'monthly')).status).toBe(400)
    expect((await basis(alex, 'ewb_date')).status).toBe(200)
    expect((await json(await get('/api/reports', alex))).basis).toBe('ewb_date')

    const sent = await app.request('/api/reports/daily/2026-03-31/send', { method: 'POST', headers: { cookie: joshy } })
    expect(sent.status).toBe(200)
    expect(media.at(-1)).toMatchObject({ number: PHONES.joshy, fileName: 'daily-report-2026-03-31.pdf' })
  })

  it('keeps balances, production values and stored reports to the manager and the admin, and re-uses an unchanged PDF', async () => {
    const app = createApp(deps)
    const cookieFor = async (email: string) => {
      const login = await app.request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'secret-pass' }) })
      return `tierra_session=${login.headers.get('set-cookie')?.match(/tierra_session=([^;]+)/)?.[1]}`
    }
    const [joshy, anju] = [await cookieFor('joshy@tierra.test'), await cookieFor('anju@tierra.test')]
    const get = async (path: string, cookie: string) => (await app.request(path, { headers: { cookie } })).json() as Promise<Record<string, any>>

    // A1: a party's balance
    expect((await get('/api/parties?q=alpha', anju)).rows[0]).not.toHaveProperty('balance')
    expect((await get('/api/parties?q=alpha', joshy)).rows[0]).toHaveProperty('balance')
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
    const tool = (tools: typeof masterTools, name: string) => tools.find((row) => row.name === name)!
    const party = async (role: 'office' | 'manager') => ((await tool(masterTools, 'find_party').run(ctxFor(role), { query: 'alpha' })) as { rows: object[] }).rows[0]
    expect(await party('office')).not.toHaveProperty('balance')
    expect(await party('manager')).toHaveProperty('balance')

    // A5: production ₹ values; quantities stay
    const office = await get('/api/production/701', anju)
    const manager = await get('/api/production/701', joshy)
    expect(manager.order.issuedValue).not.toBeNull()
    expect(office.order).toMatchObject({ issuedValue: null, receivedValue: null, completedQty: manager.order.completedQty })
    expect(office.components.every((row: any) => row.issuedValue === null)).toBe(true)
    expect(office.components.map((row: any) => row.issuedQty)).toEqual(manager.components.map((row: any) => row.issuedQty))
    expect((await get('/api/production', anju)).rows.every((row: any) => row.issuedValue === null && row.receivedValue === null)).toBe(true)
    expect((await get('/api/production', joshy)).rows.some((row: any) => row.issuedValue !== null)).toBe(true)
    const consumption = async (role: 'office' | 'manager') =>
      ((await tool(productionTools, 'consumption_vs_bom').run(ctxFor(role), { doc_no: manager.order.docNo })) as { components: Array<{ issuedValue: number | null; issuedQty: number }> }).components
    expect((await consumption('office')).every((row) => row.issuedValue === null)).toBe(true)
    expect((await consumption('manager')).some((row) => row.issuedValue !== null)).toBe(true)

    // A6: an unchanged day's PDF is served from the latest stored version; a change stores the next one
    const pdf = (cookie: string) => app.request('/api/reports/daily/2026-03-29.pdf', { headers: { cookie } })
    const first = Buffer.from(await (await pdf(joshy)).arrayBuffer())
    const v1 = await conn.store.latestDailyReport('2026-03-29')
    // rendering never changes the payload (pdfmake rewrites list items in place)
    expect((v1!.payload as { knownDifferences: unknown[] }).knownDifferences.every((line) => typeof line === 'string')).toBe(true)
    const again = Buffer.from(await (await pdf(joshy)).arrayBuffer())
    expect(again.equals(first)).toBe(true)
    expect((await conn.store.latestDailyReport('2026-03-29'))?.version).toBe(v1!.version)
    await conn.store.saveDailyInputs('2026-03-29', { notes: 'Boiler serviced' }, { userId: 'usr_anju', at: NOW })
    await pdf(joshy)
    const v2 = await conn.store.latestDailyReport('2026-03-29')
    expect(v2?.version).toBe(v1!.version + 1)
    await pdf(joshy)
    expect((await conn.store.latestDailyReport('2026-03-29'))?.version).toBe(v2!.version)

    // A4: a stored report document is finance
    expect((await app.request(`/api/documents/${v2!.documentId}`, { headers: { cookie: anju } })).status).toBe(403)
    const stored = await app.request(`/api/documents/${v2!.documentId}`, { headers: { cookie: joshy } })
    expect([stored.status, stored.headers.get('content-type')]).toEqual([200, 'application/pdf'])
  })

  it('reads the finance views directly', async () => {
    expect(await financeKpis(conn.sql, '2026-03-31')).toMatchObject({ banks: [{ bank: 'ZETA', balance: 0, houseBank: true }, { bank: 'OMEGA', balance: 3001.1 }] })
    expect((await payments(conn.sql, { direction: 'out', includeCancelled: true, from: '2026-03-01', to: '2026-03-31' })).total).toBe(5)
    expect((await payments(conn.sql, { direction: 'out', from: '2026-03-01', to: '2026-03-31' })).amount).toBe(12000)
    expect((await payments(conn.sql, { direction: 'in', transfer: true })).rows.map((row) => [row.docNo, row.bank, row.amount])).toEqual([['RT/25-26/12', 'OMEGA', 3000]])
    expect((await paymentsByPurpose(conn.sql, '2026-03-01', '2026-03-31')).total).toBe(12000)
    expect((await paymentRequests(conn.sql, { status: 'approved' })).rows[0]).toMatchObject({ paymentDocEntry: 4001, approver: 'TEST ADMIN' })
    expect((await ageingGroups(conn.sql, { side: 'payable' })).rows).toEqual([
      expect.objectContaining({ name: 'Gamma Packaging Co', net: 26000, buckets: expect.objectContaining({ not_due: 26000 }), overdue: 0 }),
    ])
    expect((await cardBalances(conn.sql, { q: 'beta' })).map((row) => [row.cardCode, row.owed])).toEqual([['ZC002', 6725]])
  })
})

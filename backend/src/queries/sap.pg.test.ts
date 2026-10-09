import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp, type AppDeps } from '../app'
import { seedIfEmpty } from '../db/seed'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { loadSapFixture } from '../test/sap'
import type { EvolutionClient } from '../whatsapp/evolution'
import { dataBrief } from './brief'
import { importMeta } from './meta'
import { poLineSummary } from './purchasing'

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres

const PASSWORD = 'secret-pass'

function deps(conn: Connection): AppDeps {
  return {
    store: conn.store,
    sapSql: conn.sql,
    evolution: {} as EvolutionClient,
    readPurchaseOrder: async () => ({ kind: 'not_po', reason: 'not used here' }),
    dataBrief: () => dataBrief(conn.sql, conn.store),
    chatModel: async () => ({ content: 'ok', toolCalls: [] }),
    enqueue: async () => true,
    botMode: 'personal',
    now: () => new Date(),
    webhookSecret: 'test-secret',
    sessionTtlMs: 60_000,
  }
}

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'alex.thomas@tierra.test', password: PASSWORD }),
  })
  expect(response.status).toBe(200)
  return `tierra_session=${response.headers.get('set-cookie')?.match(/tierra_session=([^;]+)/)?.[1]}`
}

type Json = Record<string, any>

describe.skipIf(!pg)('SAP read model on Postgres 18 (synthetic fixture)', () => {
  let conn: Connection
  let app: ReturnType<typeof createApp>
  let cookie: string

  const get = async (path: string, expected = 200): Promise<Json> => {
    const response = await app.request(path, { headers: { cookie } })
    expect(response.status, path).toBe(expected)
    return (await response.json()) as Json
  }

  beforeAll(async () => {
    const url = await pg!.createDatabase('sap_fixture')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await seedIfEmpty(conn.db, PASSWORD)
    app = createApp(deps(conn))
    cookie = await signIn(app)
  })

  afterAll(async () => {
    await conn?.close()
    await pg?.stop()
  })

  it('keeps the SAP routes behind sign-in', async () => {
    for (const path of ['/api/meta', '/api/inventory', '/api/orders/so/101', '/api/dispatch', '/api/items']) {
      expect((await app.request(path)).status, path).toBe(401)
    }
  })

  it('reports when the data was taken and imported', async () => {
    expect(await get('/api/meta')).toEqual({
      dataAsOf: '2026-03-31',
      importedAt: '2026-04-01T02:30:00.000Z',
      backup: 'synthetic_fixture',
    })
  })

  it('sums the command centre relative to the data date', async () => {
    const centre = await get('/api/command-centre')
    expect(centre.dataAsOf).toBe('2026-03-31')
    expect(centre.kpis).toEqual({
      openSalesOrders: 2,
      staleOpenSalesOrders: 1,
      salesMtdValue: 8300,
      salesMtdCount: 3,
      invoicesLastDay: 2,
      fgShortItems: 1,
    })
    expect(centre.whatsapp).toEqual({ status: 'disconnected', phoneNumber: null })
    expect(centre.recentSalesOrders.map((row: Json) => row.docNo)).toEqual([
      'SO/25-26/1',
      'SO/25-26/2',
      'SO/25-26/3',
      'SO/25-26/4',
    ])
  })

  it('lists finished-goods stock with negative free', async () => {
    const fg = await get('/api/inventory?tab=fg')
    expect(fg.kpis).toEqual({ fgItems: 2, fgShort: 1, materialsBelowZero: 0, customerSuppliedItems: 1 })
    expect(fg).toMatchObject({ total: 2, page: 1, pageSize: 50 })
    expect(fg.rows[0]).toEqual({
      itemCode: 'ZFGA100',
      itemName: 'Zeta Banana Chips 100g',
      materialRole: 'fg',
      uom: 'pcs',
      uomInferred: false,
      whsCode: 'FG01',
      onHand: 300,
      committed: 500,
      free: -200,
      onOrder: 0,
      value: 30000,
      ownerName: null,
      customerSupplied: false,
    })
    expect((await get('/api/inventory?tab=fg&q=cassava')).rows.map((row: Json) => row.itemCode)).toEqual(['ZFGB200'])
  })

  it('lists materials by role, with an inferred unit and customer-supplied laminate', async () => {
    const materials = await get('/api/inventory?tab=materials')
    expect(materials.total).toBe(5)
    expect(materials.roleCounts).toEqual({ laminate: 2, carton: 1, raw_banana: 1, seasoning: 1 })
    const laminate = await get('/api/inventory?tab=materials&role=laminate')
    expect(laminate.rows).toEqual([
      expect.objectContaining({ itemCode: 'ZPMLMA', uom: 'kg', uomInferred: true, customerSupplied: false }),
      expect.objectContaining({
        itemCode: 'ZPMLMCS',
        onHand: 12.5,
        customerSupplied: true,
        ownerName: 'Alpha Snacks Pvt Ltd',
      }),
    ])
    expect((await get('/api/inventory?tab=materials&role=carton')).rows[0]).toMatchObject({ itemCode: 'ZPMCN', onOrder: 1000 })
  })

  it('lists the order book newest first with status, stale flag and filters', async () => {
    const book = await get('/api/orders?tab=book&state=all')
    expect(book.kpis).toEqual({ open: 2, stale: 1, valueMtd: 15750, poCount: 3 })
    expect(book).toMatchObject({ total: 4, page: 1, pageSize: 50 })
    expect(book.rows.map((row: Json) => [row.docEntry, row.docNo, row.status, row.stale])).toEqual([
      [101, 'SO/25-26/1', 'open', false],
      [102, 'SO/25-26/2', 'closed', false],
      [103, 'SO/25-26/3', 'cancelled', false],
      [104, 'SO/25-26/4', 'open', true],
    ])
    expect(book.rows[0]).toEqual({
      docEntry: 101,
      docNo: 'SO/25-26/1',
      docDate: '2026-03-30',
      dueDate: '2026-04-05',
      cardCode: 'ZC001',
      cardName: 'Alpha Snacks Pvt Ltd',
      customerPoNo: 'APO-7001',
      total: 10500,
      status: 'open',
      stale: false,
      lineCount: 1,
      totalQty: 400,
      invoiceCount: 1,
    })
    const docs = async (query: string) => (await get(`/api/orders?${query}`)).rows.map((row: Json) => row.docEntry)
    expect(await docs('state=open')).toEqual([101, 104])
    expect(await docs('state=cancelled')).toEqual([103])
    expect(await docs('q=BPO-55')).toEqual([102])
    expect(await docs('q=beta')).toEqual([102, 104])
    expect(await get('/api/orders?page=2')).toMatchObject({ rows: [], total: 4, page: 2 })
    expect(await get('/api/orders?page=1e300')).toMatchObject({ rows: [], total: 4, page: 10_000 })
  })

  it('groups sales orders by the customer PO number and the customer who sent it', async () => {
    const pos = await get('/api/orders?tab=customer-pos')
    expect(pos.total).toBe(3)
    expect(pos.rows).toEqual([
      {
        customerPoNo: 'APO-7001',
        partyKey: 'AAACZ1234A',
        cardName: 'Alpha Snacks Pvt Ltd',
        cardCodes: ['ZC001'],
        salesOrderCount: 2,
        firstDate: '2026-03-10',
        lastDate: '2026-03-30',
        total: 10500,
        openCount: 1,
      },
      expect.objectContaining({ customerPoNo: 'BPO-55', partyKey: 'AABCB5678B', salesOrderCount: 1, openCount: 0 }),
      expect.objectContaining({ customerPoNo: 'APO-7001', partyKey: 'AABCB5678B', cardCodes: ['ZC002'], total: 3150 }),
    ])
    const open = await get('/api/orders?tab=customer-pos&state=open')
    expect(open.rows.map((row: Json) => [row.customerPoNo, row.partyKey, row.salesOrderCount])).toEqual([
      ['APO-7001', 'AAACZ1234A', 1],
      ['APO-7001', 'AABCB5678B', 1],
    ])
    // a row opens exactly its own orders in the order book; q stays a substring search
    const docs = async (query: string) => (await get(`/api/orders?${query}`)).rows.map((row: Json) => row.docEntry)
    expect(await docs('tab=book&po=APO-7001&party=AAACZ1234A')).toEqual([101, 103])
    expect(await docs('tab=book&po=APO-7001&party=AABCB5678B')).toEqual([104])
    expect(await docs('tab=book&po=APO-70')).toEqual([])
    expect(await docs('tab=book&q=APO-70')).toEqual([101, 103, 104])
  })

  it('opens one sales order with lines, live invoices and approval history', async () => {
    const view = await get('/api/orders/so/101')
    expect(view.order).toMatchObject({
      docNo: 'SO/25-26/1',
      poDate: '2026-03-28',
      shipToCode: 'SHIP',
      taxTotal: 500,
      approvalStatus: 'approved',
      createdBy: 'ZED OFFICE',
    })
    expect(view.lines).toEqual([
      {
        lineNum: 0,
        itemCode: 'ZFGA100',
        itemName: 'Zeta Banana Chips 100g',
        qty: 400,
        openQty: 360,
        price: 25,
        lineTotal: 10000,
        taxCode: 'IGST@5',
        taxPct: 5,
        whsCode: 'FG01',
        lineStatus: 'open',
        invoiceDocEntry: 204,
      },
    ])
    expect(view.invoices).toEqual([
      expect.objectContaining({
        docEntry: 204,
        docNo: 'TF/25-26/3',
        irnStatus: 'failed',
        ewbNo: 'EWB-900204',
        ewbCancelled: true,
        soDocEntries: [101],
      }),
    ])
    expect(view.approvals).toEqual([
      {
        docObject: '17',
        docEntry: 101,
        draftEntry: 9001,
        docNo: 'SO/25-26/1',
        status: 'approved',
        originator: 'ZED OFFICE',
        approver: 'TEST ADMIN',
        requestedAt: '2026-03-30T04:40:00.000Z',
        decidedAt: '2026-03-30T04:42:00.000Z',
        total: 10500,
      },
    ])
    await get('/api/orders/so/999', 404)
    await get('/api/orders/so/abc', 404)
    // the detail page passes the URL segment through as is; the API alone decides it is not an order
    await get(`/api/orders/so/${encodeURIComponent('1 or 1=1')}`, 404)
    await get('/api/orders/so/1e3', 404)
  })

  it('shows the data date’s dispatch without the cancellation pair', async () => {
    const day = await get('/api/dispatch')
    expect(day.date).toBe('2026-03-31')
    expect(day.kpis).toEqual({ invoices: 2, value: 6300, ewaybills: 1, irnFailures: 1 })
    expect(day.rows[0]).toEqual({
      docEntry: 201,
      docNo: 'TF/25-26/1',
      docDate: '2026-03-31',
      createdAt: '2026-03-31T09:00:05.000Z',
      cardName: 'Beta Retail LLP',
      customerPoNo: 'BPO-55',
      total: 5250,
      ewbNo: 'EWB-900201',
      ewbAt: '2026-03-31T09:02:00.000Z',
      ewbCancelled: false,
      irnStatus: 'generated',
      ackNo: 'ACK-0201',
      soDocEntries: [102],
    })
    expect(day.rows.map((row: Json) => row.docEntry)).toEqual([201, 204])
    // 204's only e-way bill was cancelled: shown, flagged, not counted; e-invoice/EWB rows whose base is not a
    // number are skipped
    expect(day.rows[1]).toMatchObject({ ewbNo: 'EWB-900204', ewbCancelled: true, irnStatus: 'failed' })
    expect((await get('/api/dispatch?date=2026-03-05')).rows.map((row: Json) => row.docNo)).toEqual(['TF/25-26/4'])
    await get('/api/dispatch?date=31-03-2026', 400)
    expect((await get('/api/dispatch/days?from=2026-03-01&to=2026-03-31')).days).toEqual([
      { date: '2026-03-05', invoices: 1, value: 2000 },
      { date: '2026-03-31', invoices: 2, value: 6300 },
    ])
    await get('/api/dispatch/days?from=2026-03-31&to=2026-03-01', 400)
  })

  it('lists production orders of every status and opens one with its components', async () => {
    const list = await get('/api/production')
    expect(list.kpis).toEqual({ openOrders: 2, completedMtdQty: 1000, ordersMtd: 3, disassemblyMtd: 1 })
    expect(list.total).toBe(4)
    expect((await get('/api/production?status=released')).rows.map((row: Json) => [row.docNo, row.type])).toEqual([
      ['PR/25-26/2', 'disassembly'],
    ])
    expect((await get('/api/production?q=cassava')).rows.map((row: Json) => row.docEntry)).toEqual([703, 702])
    const order = await get('/api/production/701')
    expect(order.order).toMatchObject({
      docNo: 'PR/25-26/1',
      docNum: 1,
      itemCode: 'ZFGA100',
      type: 'standard',
      status: 'closed',
      plannedQty: 1000,
      completedQty: 1000,
      postDate: '2026-03-18',
      closeDate: '2026-03-19',
      customerName: 'Alpha Snacks Pvt Ltd',
      stockType: 'CSP',
      issuedValue: 5000,
      receivedValue: 5000,
    })
    expect(order.components).toEqual([
      {
        lineNum: 0,
        itemCode: 'ZRMBN',
        itemName: 'Raw Banana- Test Farm',
        materialRole: 'raw_banana',
        plannedQty: 100,
        issuedQty: 100,
        uom: 'kg',
        issueMethod: 'manual',
        issuedValue: 4000,
      },
      expect.objectContaining({ itemCode: 'ZPMLMA', issueMethod: 'backflush', issuedValue: 800 }),
      expect.objectContaining({ itemCode: 'ZPMCN', uom: 'nos', issuedValue: 200 }),
    ])
    await get('/api/production/999', 404)
    await get('/api/production/abc', 404)
  })

  it('lists purchase orders with a line summary and goods receipts with free issue', async () => {
    const pos = await get('/api/procurement')
    expect(pos.kpis).toEqual({ openPos: 1, openPoValue: 11800, grnsMtd: 2, freeIssueGrnsMtd: 1 })
    expect(pos.rows).toEqual([
      {
        docEntry: 401,
        docNo: 'PO/25-26/1',
        docDate: '2026-03-15',
        cardName: 'Gamma Packaging Co',
        total: 11800,
        openValue: 11800,
        status: 'open',
        lineCount: 1,
        lineSummary: 'ZPMCN 1,000 nos @ ₹10',
      },
      expect.objectContaining({ docEntry: 402, status: 'closed', openValue: 0, lineSummary: '2 items' }),
    ])
    expect((await get('/api/procurement?tab=pos&q=laminate')).rows.map((row: Json) => row.docEntry)).toEqual([402])
    const grns = await get('/api/procurement?tab=grns')
    expect(grns.total).toBe(2)
    expect(grns.rows.map((row: Json) => [row.docNo, row.freeIssue])).toEqual([
      ['GR/25-26/2', false],
      ['GR/25-26/1', true],
    ])
    expect(grns.rows[0].lineSummary).toBe('ZPMCN 400 nos +1 more')
    expect(grns.rows[1].lineSummary).toMatch(/^ZPMLMCS \d/)
  })

  it('flags cancellation mirrors so one number names one document', async () => {
    expect(
      await conn.sql`
        select doc_entry, doc_no, cancelled, is_cancellation from erp.documents
        where doc_type = 'ap_invoice' and doc_no = 'AP/25-26/2' order by doc_entry`,
    ).toEqual([
      { doc_entry: 602, doc_no: 'AP/25-26/2', cancelled: true, is_cancellation: false },
      { doc_entry: 603, doc_no: 'AP/25-26/2', cancelled: true, is_cancellation: true },
    ])
    expect(
      await conn.sql`
        select doc_type, doc_no from erp.documents where not is_cancellation
        group by 1, 2 having count(*) > 1`,
    ).toEqual([])
    const [mirrors] = await conn.sql`select count(*)::int as n from erp.documents where is_cancellation`
    expect(mirrors?.n).toBe(2)
  })

  it('finds items and parties for pickers', async () => {
    expect((await get('/api/items?q=laminate')).rows.map((row: Json) => row.itemCode)).toEqual(['ZPMLMA', 'ZPMLMCS'])
    expect((await get('/api/items?q=ZFGA')).rows[0]).toMatchObject({ packGrams: 100, hasBom: true, gstRate: 5, pcsPerCarton: 50 })
    const parties = await get('/api/parties?q=AAACZ1234A')
    expect(parties.rows.map((row: Json) => [row.cardCode, row.cardType])).toEqual([
      ['ZC001', 'customer'],
      ['ZV001', 'supplier'],
    ])
    expect(parties.rows[0]).toMatchObject({ pan: 'AAACZ1234A', gstin: '32AAACZ1234A1Z5', balance: 125000, city: 'Kochi' })
  })

  it('briefs the agent from SAP and the task board', async () => {
    await conn.store.createTask({ title: 'Call Gamma about cartons', category: 'procurement', assigneeId: 'usr_joshy', createdBy: 'usr_alex' })
    const brief = await dataBrief(conn.sql, conn.store)
    expect(brief).toEqual({
      dataAsOf: '2026-03-31',
      openSalesOrders: {
        count: 2,
        latest: [
          { docNo: 'SO/25-26/1', customer: 'Alpha Snacks Pvt Ltd', total: 10500, customerPoNo: 'APO-7001' },
          { docNo: 'SO/25-26/4', customer: 'Beta Retail LLP', total: 3150, customerPoNo: 'APO-7001' },
        ],
      },
      fgShort: [{ itemCode: 'ZFGA100', itemName: 'Zeta Banana Chips 100g', whsCode: 'FG01', onHand: 300, committed: 500, free: -200 }],
      lastDayDispatch: { date: '2026-03-31', invoices: 2, value: 6300 },
      openTasks: [{ title: 'Call Gamma about cartons', category: 'procurement', status: 'todo', assigneeName: 'Joshy' }],
    })
  })

  it('says SAP data is not imported on a database without it', async () => {
    const url = await pg!.createDatabase('no_sap')
    await runMigrations(url)
    const bare = connect(url)
    try {
      await seedIfEmpty(bare.db, PASSWORD)
      expect(await importMeta(bare.sql)).toEqual({ dataAsOf: null, importedAt: null, backup: null })
      const bareApp = createApp(deps(bare))
      const bareCookie = await signIn(bareApp)
      const centre = await bareApp.request('/api/command-centre', { headers: { cookie: bareCookie } })
      expect(await centre.json()).toMatchObject({ dataAsOf: null, recentSalesOrders: [] })
      const stock = await bareApp.request('/api/inventory', { headers: { cookie: bareCookie } })
      expect(stock.status).toBe(503)
      expect((await dataBrief(bare.sql, bare.store)).dataAsOf).toBeNull()
    } finally {
      await bare.close()
    }
  })
})

describe('purchase-order line summary', () => {
  it('spells out a one-line PO and counts the rest', () => {
    expect(poLineSummary(1, { item: 'ZPMCN', qty: '1050.000000', uom: 'nos', price: '80.000000' })).toBe(
      'ZPMCN 1,050 nos @ ₹80',
    )
    expect(poLineSummary(1, { item: 'ZRMBN', qty: 125000.5, uom: null, price: 42.75 })).toBe('ZRMBN 1,25,000.5 @ ₹42.75')
    expect(poLineSummary(3, null)).toBe('3 items')
    expect(poLineSummary(0, null)).toBeNull()
  })
})

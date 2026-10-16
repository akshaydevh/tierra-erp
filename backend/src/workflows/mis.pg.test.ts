import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { seedIfEmpty } from '../db/seed'
import { SETTING_CUSTOMER_RULES, SETTING_GL_RULES } from '../domain/mis'
import { buildMis } from '../queries/mis'
import { connect, runMigrations, startPostgres, type Connection } from '../test/postgres'
import { loadHrFixture, loadSapFixture } from '../test/sap'

// The monthly MIS on the synthetic fixtures. SAP (data date 2026-03-31): production order 701 made 1,000 ZFGA100
// (100 g) for ZC001 from 4,000 of banana and 1,000 of laminate and cartons; ZFGA100 invoiced to ZC001 at 25; March GL:
// industrial gas 1,200, repairs (others) 800, misc income 1.10; February: the salary journal of 80,000. HR: the
// February 2026 payrolls (register peeling 22,000, office 30,000, sales promotion 10,000; temps 12,300 + 8,000).

const harness = await startPostgres()
if (harness.skipReason) console.warn(harness.skipReason)
const pg = harness.postgres
const NOW = new Date('2026-04-03T06:00:00Z')

describe.skipIf(!pg)('monthly MIS (synthetic fixtures)', () => {
  let conn: Connection
  let url: string
  const mis = (month: string) => buildMis({ sapSql: conn.sql, store: conn.store }, { month, dataAsOf: '2026-03-31', now: NOW })

  beforeAll(async () => {
    url = await pg!.createDatabase('mis_fixture')
    await runMigrations(url)
    await loadSapFixture(url)
    conn = connect(url)
    await seedIfEmpty(conn.db, 'secret-pass')
  })

  afterAll(async () => {
    await conn?.close()
    await pg?.stop()
  })

  it('builds the Costing P&L, the month per customer and the GL page from SAP', async () => {
    const march = await mis('2026-03-01')
    expect(march.months[0]).toBe('2025-04-01')
    expect(march.months).toHaveLength(12)
    expect(march.current).toMatchObject({
      productionKg: 100,
      sales: 25000,
      banana: 4000,
      packing: 1000,
      oil: 0,
      materials: 5000,
      mom: 20000,
      repairs: 800,
      otherVariable: 1200,
      variable: 2000,
      contribution: 18000,
      fixed: 0,
      otherIncome: 1.1,
      ebitda: 18001.1,
      labourSource: 'none',
      bananaKg: 100,
    })
    expect(march.customers).toEqual([expect.objectContaining({ label: 'Alpha Snacks', cards: ['ZC001'], kg: 100, sales: 25000, banana: 4000, mom: 20000, otherVariable: 2000, contribution: 18000 })])
    expect(march.customerTotal).toMatchObject({ label: 'Total', mom: 20000, netMargin: 18000 })
    expect(march.gl).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ glCode: 'ZGAS', line: 'other_variable', amount: 1200 }),
        expect.objectContaining({ glCode: 'ZREP', line: 'repairs', amount: 800 }),
        expect.objectContaining({ glCode: 'ZMISC', line: 'other_income', amount: 1.1 }),
        expect.objectContaining({ glCode: 'ZPURCH', line: 'ignore' }),
        expect.objectContaining({ glCode: 'ZSALES', line: 'ignore' }),
      ]),
    )
    expect(march.notes.join(' ')).toContain('No "Purchases - Agri" account')
    expect(march.notes.join(' ')).toContain('no labour cost')
    expect(march.sales.map((row) => [row.itemCode, row.value])).toEqual([
      ['ZFGB200', 6904.76],
      ['ZFGA100', 1000],
    ])
    // February carries the salary journal: wages from SAP, as no HR payroll is loaded
    expect(march.pnl.find((p) => p.month === '2026-02-01')).toMatchObject({ wages: 80000, labourSource: 'gl', ebitda: -80000 })
    expect(march.fyTotal).toMatchObject({ productionKg: 100, wages: 80000, ebitda: -61998.9 })
    expect(march.trend).toEqual([expect.objectContaining({ label: 'Alpha Snacks', kg: 100, mom: 20000 })])

    // the reconciliation steps add up to the change in EBITDA
    const steps = march.reconciliation!
    const middle = steps.slice(1, -1).reduce((sum, step) => sum + step.amount, 0)
    expect(Math.round((steps[0]!.amount + middle) * 100) / 100).toBe(steps.at(-1)!.amount)

    const april = await mis('2026-04-01')
    expect(april).toMatchObject({ noData: true })
    expect(april.notes[0]).toContain('SAP data ends 2026-03-31')
  })

  it('follows the saved MIS rules before the defaults', async () => {
    await conn.store.saveSetting(SETTING_GL_RULES, [{ match: 'Industrial Gas%', line: 'admin' }], null)
    await conn.store.saveSetting(SETTING_CUSTOMER_RULES, [{ card: 'ZC001', label: 'Alpha Brand' }], null)
    const march = await mis('2026-03-01')
    // gas moves from variable to fixed costs: contribution goes up, EBITDA stays
    expect(march.current).toMatchObject({ otherVariable: 0, contribution: 19200, admin: 1200, fixed: 1200, ebitda: 18001.1 })
    expect(march.customers.map((row) => row.label)).toEqual(['Alpha Brand'])
    await conn.store.saveSetting(SETTING_GL_RULES, [], null)
    await conn.store.saveSetting(SETTING_CUSTOMER_RULES, [], null)
    expect((await mis('2026-03-01')).current).toMatchObject({ contribution: 18000, fixed: 0 })
  })

  it('takes labour from the HR payroll when it is loaded for the month, and leaves the salary journal out', async () => {
    await loadHrFixture(url)
    const feb = await mis('2026-02-01')
    expect(feb.current).toMatchObject({ labourSource: 'hr', peeling: 22000, wages: 12300, salaryFixed: 30000, selling: 18000, fixed: 30000, ebitda: -64300 })
    expect(feb.gl.filter((row) => row.line === 'salaries_gl').map((row) => row.amount)).toEqual([50000, 30000])
    expect(feb.notes.join(' ')).not.toContain('Labour')
  })
})

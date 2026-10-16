import pdfParse from 'pdf-parse'
import { describe, expect, it } from 'vitest'
import { closePnl, emptyPnl, reconcile, sumPnl, type PnlMonth } from '../domain/mis'
import type { MisCustomer, MisPayload } from '../queries/mis'
import { misDefinition, renderMisPdf } from './mis'

function month(m: string, kg: number): PnlMonth {
  return closePnl({
    ...emptyPnl(m),
    productionKg: kg,
    sales: kg * 340,
    banana: kg * 143,
    packing: kg * 28,
    oil: kg * 41,
    flavour: kg * 5,
    lpg: kg * 24,
    power: kg * 2.6,
    peeling: kg * 9.6,
    water: kg * 0.34,
    transport: kg * 2.5,
    wages: kg * 11.4,
    repairs: kg * 4.3,
    otherVariable: kg * 3.1,
    salaryFixed: kg * 6.4,
    staffWelfare: kg * 1.2,
    professional: kg * 3,
    admin: kg * 2.4,
    financeCharges: kg * 1.1,
    otherIncome: 77556.49,
    selling: 375305,
    labourSource: 'hr',
  })
}

function customer(label: string, kg: number): MisCustomer {
  const sales = kg * 350
  const materials = kg * 216
  const variable = kg * 46
  const fixed = kg * 30
  return { label, cards: ['ZC001'], kg, sales, banana: kg * 143, packing: kg * 27, oil: kg * 41, flavour: kg * 5, materials, mom: sales - materials, lpg: kg * 24, otherVariable: kg * 22, variable, contribution: sales - materials - variable, fixed, netMargin: sales - materials - variable - fixed }
}

function payload(patch: Partial<MisPayload> = {}): MisPayload {
  const pnl = [month('2026-04-01', 58344.56), month('2026-05-01', 72125.57), month('2026-06-01', 70600)]
  const customers = ['Zeta', 'Omega', 'Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Kappa', 'Lambda'].map((label, i) => customer(label, 21000 / (i + 1)))
  return {
    month: '2026-06-01',
    months: pnl.map((p) => p.month),
    dataAsOf: '2026-07-30',
    generatedAt: '2026-07-31T04:00:00Z',
    pnl,
    fyTotal: sumPnl(pnl, 'FY'),
    current: pnl[2]!,
    reconciliation: reconcile(pnl[1]!, pnl[2]!),
    customers,
    customerTotal: { ...customer('Total', 70600), cards: [] },
    trend: customers.map((c) => ({ label: c.label, months: pnl.map((p) => ({ month: p.month, kg: c.kg, mom: c.mom })), kg: c.kg * 3, mom: c.mom * 3 })),
    consumption: [
      { category: 'Packing materials', opening: 10591336.39, receipts: 3392682.65, issues: 1950659.69, closing: 11629566.39 },
      { category: 'Oil', opening: 1946650.68, receipts: 2273713.14, issues: 2876840.25, closing: 1343523.57 },
    ],
    sales: [{ itemCode: 'ZFGA60', itemName: 'Zeta Banana Chips 60g', qty: 109578, kg: 6574.68, value: 2563050.84 }],
    otherSales: [{ itemCode: 'ZSCRAP', itemName: 'Scrap Carton', qty: 162, kg: null, value: 2203.2 }],
    gl: [
      { glCode: 'Z1', account: 'Electricity Charges', line: 'power', amount: 180984 },
      { glCode: 'Z2', account: 'Something New', line: 'unmapped', amount: 1234 },
    ],
    notes: ['1 expense account with no MIS rule (₹1,234) left out: see the GL page.'],
    noData: false,
    ...patch,
  }
}

describe('MIS PDF', () => {
  it('prints the summary, the Costing P&L, the customers, the comparison, consumption and the GL on landscape pages', async () => {
    expect(misDefinition(payload())).toMatchObject({ pageSize: 'A4', pageOrientation: 'landscape' })
    const { text, numpages } = await pdfParse(await renderMisPdf(payload()))
    expect(numpages).toBeGreaterThanOrEqual(6)
    for (const expected of [
      'MONTHLY MIS · JUNE 2026',
      'EBITDA reconciliation',
      'EBITDA for May 2026',
      'Costing profit and loss statement',
      'Apr 26',
      'FY 26-27',
      '70,600',
      'Margin on materials',
      'Memo: sales promotion (outside EBITDA)',
      'Customer-wise, June 2026',
      'Lambda',
      'Customer-wise margin comparison',
      'Stock movement, June 2026',
      'Scrap Carton (other income)',
      'NO RULE: left out',
      'page 1 of',
    ]) {
      expect(text).toContain(expected)
    }
  })

  it('splits the customers over tables of seven, the total on the last', () => {
    const tables = (misDefinition(payload()).content as Array<Record<string, any>>).filter((part) => part.table && part.margin?.[3] === 6)
    expect(tables.map((part) => part.table.body[0].length - 1)).toEqual([7, 3])
    expect(tables[1]!.table.body[0].at(-1).text).toBe('Total')
  })

  it('prints a month past the SAP data as a notice', async () => {
    const { text } = await pdfParse(await renderMisPdf(payload({ noData: true, notes: ['SAP data ends 2026-07-30: there is no MIS for August 2026 yet.'] })))
    expect(text).toContain('there is no MIS for August 2026 yet')
    expect(text).not.toContain('Costing profit and loss statement')
  })
})

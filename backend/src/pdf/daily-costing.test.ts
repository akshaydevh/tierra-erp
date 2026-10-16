import pdfParse from 'pdf-parse'
import { describe, expect, it } from 'vitest'
import { NOT_IN_SAP, type CostingColumn, type CostLine, type DailyCostingPayload, type OrderCost } from '../queries/daily-costing'
import { dailyCostingDefinition, renderDailyCostingPdf } from './daily-costing'

type Sku = { code: string; name: string; customer: string; pouches: number; grams: number; price: number; lines: Partial<Record<CostLine, number>>; bananaKg: number }

const SKUS: Sku[] = [
  { code: 'ZFGHPS60', name: 'Zeta Banana Chips Pink Salt 60g', customer: 'Gamma Industries Limited', pouches: 27190, grams: 60, price: 25.01, lines: { banana: 242723, packing: 120816, oil: 58074, flavour: 1644, lpg: 36681, consumables: 129 }, bananaKg: 5920.08 },
  { code: 'ZFGOS300', name: 'Zeta Banana Chips 300g', customer: 'Delta Food Ventures Private Limited', pouches: 2129, grams: 300, price: 105, lines: { banana: 95027, packing: 6416, oil: 25899, flavour: 389, lpg: 14940, consumables: 13 }, bananaKg: 2317.74 },
  { code: 'ZFGKOR60', name: 'Zeta Banana Chips Korean 60g', customer: 'Gamma Industries Limited', pouches: 8098, grams: 60, price: 23.39, lines: { banana: 72290, packing: 22965, oil: 17332, flavour: 7152, lpg: 10884 }, bananaKg: 1763.18 },
]

function lines(partial: Partial<Record<CostLine, number>>): Record<CostLine, number> {
  return { banana: 0, packing: 0, oil: 0, flavour: 0, other_material: 0, lpg: 0, consumables: 0, ...partial }
}

function columnOf(sku: Sku | null, all: Sku[]): CostingColumn {
  const list = sku ? [sku] : all
  const sum = (pick: (s: Sku) => number) => list.reduce((total, s) => total + pick(s), 0)
  const l = lines({})
  for (const s of list) for (const [key, value] of Object.entries(s.lines)) l[key as CostLine] += value
  const kg = sum((s) => (s.pouches * s.grams) / 1000)
  const sales = sum((s) => s.pouches * s.price)
  const material = l.banana + l.packing + l.oil + l.flavour + l.other_material
  const production = l.lpg + l.consumables
  return {
    itemCode: sku?.code ?? null,
    itemName: sku?.name ?? 'Total',
    customers: [...new Set(list.map((s) => s.customer))],
    orders: list.map((s) => `PR/26-27/${s.pouches}`),
    pouches: sum((s) => s.pouches),
    kg,
    pricePerPouch: sku?.price ?? null,
    sales,
    unpricedPouches: 0,
    lines: l,
    materialCost: material,
    marginOnMaterial: sales - material,
    productionCost: production,
    contribution: sales - material - production,
    bananaKg: sum((s) => s.bananaKg),
  }
}

function order(sku: Sku): OrderCost {
  const l = lines(sku.lines)
  return {
    docEntry: sku.pouches,
    docNo: `PR/26-27/${sku.pouches}`,
    itemCode: sku.code,
    itemName: sku.name,
    cardCode: 'ZC001',
    customerName: sku.customer,
    pouches: sku.pouches,
    kg: (sku.pouches * sku.grams) / 1000,
    share: 1,
    lines: l,
    bananaKg: sku.bananaKg,
    materialCost: l.banana + l.packing + l.oil + l.flavour,
    pricePerPouch: sku.price,
    priceSource: 'customer',
    priceDate: '2026-07-06',
    sales: sku.pouches * sku.price,
  }
}

function samplePayload(patch: Partial<DailyCostingPayload> = {}): DailyCostingPayload {
  const total = columnOf(null, SKUS)
  return {
    kind: 'full',
    date: '2026-07-04',
    dataAsOf: '2026-07-30',
    generatedAt: '2026-07-31T04:00:00Z',
    columns: SKUS.map((sku) => columnOf(sku, SKUS)),
    total,
    orders: SKUS.map(order),
    yieldPct: Math.round((total.kg! / total.bananaKg) * 10_000) / 100,
    bananaPerFgKg: Math.round((total.bananaKg / total.kg!) * 100) / 100,
    notes: ['Material cost is what SAP issued to each production order at its stock value.'],
    notInSap: [...NOT_IN_SAP],
    ...patch,
  }
}

describe('daily costing PDF', () => {
  it('prints the costing sheet on one landscape A4 page with value and per-kg columns', async () => {
    const definition = dailyCostingDefinition(samplePayload())
    expect(definition).toMatchObject({ pageSize: 'A4', pageOrientation: 'landscape' })
    const { text, numpages } = await pdfParse(await renderDailyCostingPdf(samplePayload()))
    expect(numpages).toBe(1)
    for (const expected of [
      'DAILY COSTING REPORT',
      'Production date 04-07-2026',
      'Zeta Banana Chips Korean 60g',
      'Total',
      '2,755.98', // kg made
      '10,92,979', // sales value
      '4,10,040', // banana & cassava
      'Margin on material',
      'Cost of LPG consumed',
      'Contribution (after SAP costs only)',
      'PR/26-27/27190',
      'Not in SAP, so left out of every figure',
      'Power and water',
    ]) {
      expect(text).toContain(expected)
    }
  })

  it('prints a day without production as a short notice', async () => {
    const { text } = await pdfParse(
      await renderDailyCostingPdf(samplePayload({ kind: 'no_production', columns: [], orders: [], notes: ['No finished goods were received from production in SAP on this day.'] })),
    )
    expect(text).toContain('No finished goods were received from production in SAP on this day.')
    expect(text).not.toContain('Margin on material')
  })

  it('splits a day with many SKUs over more tables, the total on the last', () => {
    const many = Array.from({ length: 7 }, (_, index) => ({ ...SKUS[0]!, code: `ZFG${index}`, name: `SKU ${index}` }))
    const payload = samplePayload({ columns: many.map((sku) => columnOf(sku, many)), total: columnOf(null, many) })
    const tables = (dailyCostingDefinition(payload).content as Array<Record<string, any>>).filter((part) => part.table?.headerRows === 3)
    expect(tables.map((part) => part.table.widths.length)).toEqual([1 + 5 * 2, 1 + 3 * 2])
  })
})

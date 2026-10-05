import { describe, expect, it } from 'vitest'
import { bananaRequirement, gramsFromDescription, kgBananaPerKgChips } from './banana'

describe('banana yield', () => {
  it('weights June and July banana receipts by chips produced', () => {
    const factor = kgBananaPerKgChips()
    expect(factor).toBeCloseTo((33961.67 + 100000) / (9092.02 + 23860), 8)
    expect(Math.round(factor * 1000) / 1000).toBe(4.065)
  })

  it('turns the Trent purchase order into finished-goods kilograms and banana', () => {
    const result = bananaRequirement([
      { description: 'Fabsta Banana chips Salted 170g', quantity: 23220, unit: 'PC' },
      { description: 'Fabsta Banana Chips 500g', quantity: 2640, unit: 'PC' },
    ])
    expect(result.finishedGoodsKg).toBe(5267.4)
    expect(result.kgBananaPerKgChips).toBe(4.065)
    expect(result.bananaKg).toBe(21413.853)
    expect(result.sourceMonths).toBe('June 2026, July 2026')
    expect(result.skipped).toEqual([])
  })

  it('reads grams written as g, gm, or grm', () => {
    expect(gramsFromDescription('TIERRA BANANA CHIPS 100 G PP')).toBe(100)
    expect(gramsFromDescription('TIERRA PRM KERALA BANANA CHIPS 500G PP')).toBe(500)
    expect(gramsFromDescription('banana chips 100 grm per packet')).toBe(100)
    expect(gramsFromDescription('banana chip 500 gm per packet')).toBe(500)
  })

  it('leaves carton lines and lines without a pack weight out of the total', () => {
    const result = bananaRequirement([
      { description: 'Tierra Banana Chips 100g', quantity: 2, unit: 'CRT' },
      { description: 'Banana chips', quantity: 10, unit: 'pouch' },
      { description: 'Banana chips 40g', quantity: 10, unit: null },
    ])
    expect(result.finishedGoodsKg).toBe(0)
    expect(result.bananaKg).toBe(0)
    expect(result.skipped).toEqual(['Tierra Banana Chips 100g', 'Banana chips', 'Banana chips 40g'])
  })
})
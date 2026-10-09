import { describe, expect, it } from 'vitest'
import { normaliseUnit, parseReceipt, unitFits } from './receipts'

describe('receipts', () => {
  it('reads every quantity, unit and item of a "received" message', () => {
    expect(parseReceipt('received 20 kg ZPMLMN, 160 kg ZOILP')).toEqual([
      { qty: 20, unit: 'kg', itemCode: 'ZPMLMN' },
      { qty: 160, unit: 'kg', itemCode: 'ZOILP' },
    ])
    expect(parseReceipt('Received: 2.5 kgs zflsalt and 1,500 nos ZPMCN5')).toEqual([
      { qty: 2.5, unit: 'kg', itemCode: 'ZFLSALT' },
      { qty: 1500, unit: 'nos', itemCode: 'ZPMCN5' },
    ])
    expect(parseReceipt('received 20 kg ZPMLMN,160 kg ZOILP').map((line) => line.qty)).toEqual([20, 160])
    expect(parseReceipt('received 40 ZPMTP')).toEqual([{ qty: 40, unit: null, itemCode: 'ZPMTP' }])
    expect(parseReceipt('received the cartons')).toEqual([])
    expect(parseReceipt('what did we receive?')).toBeNull()
  })

  it('checks the typed unit against the SAP unit (pieces and nos are the same)', () => {
    expect(unitFits('kg', 'kg')).toBe(true)
    expect(unitFits('nos', 'pcs')).toBe(true)
    expect(unitFits(null, 'kg')).toBe(true)
    expect(unitFits('kg', 'nos')).toBe(false)
  })

  it('spells litres one way, as SAP does (ltr), whatever was typed', () => {
    expect(parseReceipt('received 50 litres ZOILP, 5 L ZOILQ, 2 ltrs ZOILR').map((line) => line.unit)).toEqual(['ltr', 'ltr', 'ltr'])
    expect(normaliseUnit('Litre')).toBe('ltr')
    expect(normaliseUnit('l')).toBe('ltr')
    expect(unitFits('ltr', 'ltr')).toBe(true)
    expect(unitFits('l', 'ltr')).toBe(true)
    expect(unitFits('ltr', 'kg')).toBe(false)
  })
})

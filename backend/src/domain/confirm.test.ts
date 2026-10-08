import { describe, expect, it } from 'vitest'
import { confirmationChoice, samePoNumber } from './confirm'

describe('purchase order confirmation', () => {
  it('accepts an admin yes and a no', () => {
    expect(confirmationChoice('YES')).toEqual({ answer: 'yes', poNumber: null })
    expect(confirmationChoice('confirm.')).toEqual({ answer: 'yes', poNumber: null })
    expect(confirmationChoice('no')).toEqual({ answer: 'no', poNumber: null })
    expect(confirmationChoice('yes please')).toBeNull()
    expect(confirmationChoice('ok done')).toBeNull()
  })

  it('reads a PO number after the answer', () => {
    expect(confirmationChoice('yes 5901346472')).toEqual({ answer: 'yes', poNumber: '5901346472' })
    expect(confirmationChoice('No PO-SHORT.')).toEqual({ answer: 'no', poNumber: 'PO-SHORT' })
    expect(confirmationChoice('yes PO 43/2026')).toEqual({ answer: 'yes', poNumber: '43/2026' })
    expect(confirmationChoice('yes po# 43')).toEqual({ answer: 'yes', poNumber: '43' })
    expect(confirmationChoice('yes #43')).toEqual({ answer: 'yes', poNumber: '43' })
    expect(confirmationChoice('yes to PO 43')).toBeNull()
    expect(samePoNumber('po-short', ' PO-SHORT ')).toBe(true)
  })
})

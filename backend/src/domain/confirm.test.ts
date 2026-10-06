import { describe, expect, it } from 'vitest'
import { confirmationChoice } from './confirm'

describe('purchase order confirmation', () => {
  it('accepts an admin yes and a no', () => {
    expect(confirmationChoice('YES')).toBe('yes')
    expect(confirmationChoice('confirm.')).toBe('yes')
    expect(confirmationChoice('no')).toBe('no')
    expect(confirmationChoice('yes please')).toBeNull()
  })
})
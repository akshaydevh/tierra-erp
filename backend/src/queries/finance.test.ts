import { describe, expect, it } from 'vitest'
import { cutoffTime, groupName, tidyAccountName } from './finance'

describe('finance helpers', () => {
  it('names a company after the words its branch cards share', () => {
    expect(groupName(['Zeta Foods Limited, Delhi', 'Zeta Foods Ltd Mumbai', 'Zeta Foods Limited-Kolkata'], 'PAN')).toBe('Zeta Foods')
    expect(groupName(['Omega Retail LLP'], 'PAN')).toBe('Omega Retail LLP')
    expect(groupName(['Alpha One', 'Beta Two'], 'PAN')).toBe('Alpha One')
    expect(groupName([], 'ZC009')).toBe('ZC009')
  })

  it('reads the cut-off and tidies account names', () => {
    expect(cutoffTime('19:30')).toBe('19:30:00')
    expect(cutoffTime('7:05')).toBe('07:05:00')
    expect(cutoffTime('25:00')).toBe('19:30:00')
    expect(cutoffTime(null)).toBe('19:30:00')
    expect(tidyAccountName('Industrial Gas Expenses (TRA)')).toBe('Industrial Gas Expenses')
    expect(tidyAccountName(null)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { addMonths, lastDayOf, monthLabel, parseMonth } from './months'

describe('months as people type them', () => {
  it('reads names, numbers and words', () => {
    expect(parseMonth('June', '2026-10-07')).toBe('2026-06-01')
    expect(parseMonth('jun 26', '2026-10-07')).toBe('2026-06-01')
    expect(parseMonth("June '25", '2026-10-07')).toBe('2025-06-01')
    expect(parseMonth('sept 2026', '2026-10-07')).toBe('2026-09-01')
    expect(parseMonth('2026-07', '2026-10-07')).toBe('2026-07-01')
    expect(parseMonth('7/2026', '2026-10-07')).toBe('2026-07-01')
    expect(parseMonth('last month', '2026-01-15')).toBe('2025-12-01')
    expect(parseMonth('this month', '2026-01-15')).toBe('2026-01-01')
  })

  it('takes a month without a year from what is on file, else the latest one so far', () => {
    expect(parseMonth('December', '2026-10-07')).toBe('2025-12-01')
    expect(parseMonth('June', '2026-10-07', ['2025-06-01', '2024-06-01'])).toBe('2025-06-01')
  })

  it('does not take words that only start like a month', () => {
    expect(parseMonth('marketing', '2026-10-07')).toBeNull()
    expect(parseMonth('TF905', '2026-10-07')).toBeNull()
    expect(parseMonth('details', '2026-10-07')).toBeNull()
    expect(parseMonth('13/2026', '2026-10-07')).toBeNull()
  })

  it('labels and steps months', () => {
    expect(monthLabel('2026-06-01')).toBe('June 2026')
    expect(lastDayOf('2026-02-01')).toBe('2026-02-28')
    expect(lastDayOf('2024-02-01')).toBe('2024-02-29')
    expect(addMonths('2026-01-01', -1)).toBe('2025-12-01')
    expect(addMonths('2026-11-01', 3)).toBe('2027-02-01')
  })
})

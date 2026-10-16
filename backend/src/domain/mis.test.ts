import { describe, expect, it } from 'vitest'
import { DEFAULT_CUSTOMER_RULES, DEFAULT_GL_RULES, closePnl, customerLabelOf, defaultMisMonth, emptyPnl, fyMonths, glLineOf, likeMatch, reconcile } from './mis'

describe('MIS rules', () => {
  it('matches account names like SQL ILIKE', () => {
    expect(likeMatch('Electricity%', 'Electricity Charges')).toBe(true)
    expect(likeMatch('Repair%Plant%', 'Repair and Maintanance-Plant')).toBe(true)
    expect(likeMatch('Waste Di%', 'waste diposal charges')).toBe(true)
    expect(likeMatch('Tea%', 'Telephone Charges')).toBe(false)
    expect(likeMatch('Lab_', 'Labs')).toBe(true)
    expect(likeMatch('(TRA)%', '(TRA) x')).toBe(true)
  })

  it('puts the June 2026 MIS accounts on its lines', () => {
    const line = (name: string, side: 'income' | 'expense' = 'expense') => glLineOf(DEFAULT_GL_RULES, { name, side })
    expect(line('Purchases - Agri')).toBe('banana_cassava')
    expect(line('Purchases Non-Agri')).toBe('ignore')
    expect(line('Electricity Charges')).toBe('power')
    expect(line('Water charges')).toBe('water')
    expect(line('Goods Transporting Charges')).toBe('transport')
    expect(line('Repair and Maintanance-Plant')).toBe('repairs')
    expect(line('Repairs & Maintenance- Building')).toBe('repairs_fixed')
    expect(line('Waste Diposal Charges')).toBe('other_variable')
    expect(line('Salary and allowances -Office')).toBe('salaries_gl')
    expect(line('Staff Welfare Expense')).toBe('staff_welfare')
    expect(line('Legal and Professional Charges')).toBe('professional')
    expect(line('Travel and Conveyance Expenses-Office')).toBe('conveyance')
    expect(line('Interst on ICICI Loan 58L')).toBe('finance_charges')
    expect(line('Interest on delayed payments to Suppliers')).toBe('interest_delayed')
    expect(line('Interst and Penalties')).toBe('admin')
    expect(line('Sales Promotion Expense')).toBe('selling')
    expect(line('Work in Progress Variance')).toBe('ignore')
    expect(line('Something New')).toBe('unmapped')
    expect(line('Sales Revenue', 'income')).toBe('ignore')
    expect(line('Interest  Received', 'income')).toBe('other_income')
  })

  it('names the MIS customer by card first, then the item-code prefix, else the fallback', () => {
    const label = (itemCode: string, cardCode: string | null) => customerLabelOf(DEFAULT_CUSTOMER_RULES, { itemCode, cardCode, fallback: 'Other' })
    expect(label('FGKBK300', 'C0142')).toBe('Snackable')
    expect(label('FGTYMCCP65', 'C0150')).toBe('Too Yumm Cassava')
    expect(label('FGTYMBSK60', 'C0150')).toBe('Too Yumm')
    expect(label('FGFBOS500', 'C0015')).toBe('TATA')
    expect(label('ZFGA100', 'ZC001')).toBe('Other')
  })

  it('picks the month and the financial year', () => {
    expect(defaultMisMonth('2026-07-30', '2026-10-16')).toBe('2026-06-01')
    expect(defaultMisMonth('2026-03-31', '2026-04-03')).toBe('2026-03-01')
    expect(fyMonths('2026-06-01')).toEqual(['2026-04-01', '2026-05-01', '2026-06-01'])
    expect(fyMonths('2026-03-01')).toHaveLength(12)
  })

  it('reconciles EBITDA month on month: the steps add up to the change', () => {
    const month = (m: string, patch: Partial<ReturnType<typeof emptyPnl>>) => closePnl({ ...emptyPnl(m), ...patch })
    const may = month('2026-05-01', { productionKg: 72125.57, sales: 22720994.94, banana: 10912246.53, packing: 2147324.48, oil: 2721420.15, flavour: 383306.54, lpg: 1705334.57, wages: 2640011, salaryFixed: 448724, admin: 751764, otherIncome: 230298.08 })
    const june = month('2026-06-01', { productionKg: 70600, sales: 24769514.57, banana: 10097033.75, packing: 1964238.89, oil: 2876840.25, flavour: 356466.46, lpg: 1670253.1, wages: 2392201, salaryFixed: 452710, admin: 851159, otherIncome: 77556.49 })
    for (const steps of [reconcile(may, june), reconcile({ ...may, productionKg: 0 }, june)]) {
      const sum = steps.slice(0, -1).reduce((total, step) => total + step.amount, 0)
      expect(Math.abs(sum - steps.at(-1)!.amount)).toBeLessThan(0.05)
    }
    expect(june.mom).toBe(9474935.22)
  })
})

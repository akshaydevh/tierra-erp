import { describe, expect, it } from 'vitest'
import { parsePayrollCommand, payrollText } from './hr-commands'
import { isHrQuestion, namesAsked, withoutEmployeeCodes } from './hr-gate'

describe('payroll privacy gate', () => {
  it('lets names out only when the message asks for people', () => {
    for (const text of ['salary of TF905', 'what did Asha get paid? names please', 'who was absent on 3 Feb', 'top peelers in July', 'net pay of Bala Nair', 'show each person', 'list of staff on leave']) {
      expect(namesAsked(text), text).toBe(true)
    }
    for (const text of ['Payroll June', 'payroll for June 2026', 'how much was the salary for July', 'attendance in June', 'total ESI this month', '', null]) {
      expect(namesAsked(text), String(text)).toBe(false)
    }
  })

  it('knows a payroll, attendance or leave question, but not a salary payment', () => {
    for (const text of ['Payroll June', 'salary of TF905', 'attendance on 3 Feb', 'who was absent yesterday?', 'leave requests this month', 'peeling incentive July', 'headcount?']) {
      expect(isHrQuestion(text), text).toBe(true)
    }
    for (const text of ['salary payments this month', 'SBI balance', 'what did PR 101 cost?', 'margin on FGZZAB60']) {
      expect(isHrQuestion(text), text).toBe(false)
    }
  })

  it('keeps employee codes out of the document pre-resolver', () => {
    expect(withoutEmployeeCodes('salary of TF905 and T99, invoice TF/25-26/1').replace(/\s+/g, ' ')).toBe('salary of and , invoice TF/25-26/1')
  })

  it('reads the payroll command', () => {
    expect(parsePayrollCommand('Payroll June', '2026-10-07')).toEqual({ monthText: 'June' })
    expect(parsePayrollCommand('payroll', '2026-10-07')).toEqual({ monthText: null })
    expect(parsePayrollCommand('show me the salary for jun 2026', '2026-10-07')).toEqual({ monthText: 'jun 2026' })
    expect(parsePayrollCommand('payroll summary last month', '2026-10-07')).toEqual({ monthText: 'last month' })
    expect(parsePayrollCommand('salary of TF905', '2026-10-07')).toBeNull()
    expect(parsePayrollCommand('salary marketing', '2026-10-07')).toBeNull()
    expect(parsePayrollCommand('what is the payroll', '2026-10-07')).toBeNull()
  })

  it('writes category totals and no names', () => {
    const text = payrollText(
      {
        month: '2026-02-01',
        runs: [
          {
            runId: 'voyon-2026-02', month: '2026-02-01', source: 'voyon', label: 'Voyon payroll', fileName: 'f', headcount: 3,
            grossEarned: 60000, totalEarning: 64000, deductions: 2890, net: 61110, pf: 1800, esi: 90, tds: 1000, basic: 57000,
            categories: [{ category: 'Admin', label: 'Admin', people: 1, grossEarned: 30000, totalEarning: 30000, pf: 0, esi: 0, deductions: 1000, net: 29000 }],
          },
          {
            runId: 'register-2026-02', month: '2026-02-01', source: 'register', label: 'Salary register', fileName: 'f', headcount: 3,
            grossEarned: 58000, totalEarning: 62000, deductions: 2800, net: 59200, pf: 1800, esi: 0, tds: 1000, basic: 55000,
            categories: [{ category: 'office_admin', label: 'Office & Admin', people: 1, grossEarned: 30000, totalEarning: 30000, pf: 0, esi: 0, deductions: 1000, net: 29000 }],
          },
        ],
      },
      { month: '2026-02-01', payroll: { voyonNet: 61110, voyonEarned: 64000, registerEarned: 62000, registerNet: 59200, tempEarned: null, tempNet: null }, journal: [], journalTotal: 80000, employerContribution: 0, paidInMonth: 0, paidNextMonth: 78000, paymentsNextMonth: 2 },
    )
    expect(text).toContain('*Payroll February 2026*')
    expect(text).toContain('*Voyon payroll*: 3 people, net *₹61,110*')
    expect(text).toContain('• Office & Admin: 1, ₹29,000')
    expect(text).toContain('same permanent staff: do not add them')
    expect(text).toContain('SAP: salary journal ₹80,000; salary payments the next month ₹78,000 (2).')
  })
})

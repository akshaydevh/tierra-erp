import { describe, expect, it } from 'vitest'
import { defaultInputDate, namedDay } from '../domain/daily-report'
import { gateEffects } from './effect-gate'
import { isFinanceQuestion, parseEstimate, parseManpower, parseReportRequest } from './report-commands'

const TODAY = '2026-10-09'

describe('daily report commands', () => {
  it('reads manpower with an optional day', () => {
    expect(parseManpower('manpower 7 6 6 7 19 25 2 13')).toEqual({ counts: [7, 6, 6, 7, 19, 25, 2, 13], dateText: null })
    expect(parseManpower('Manpower: 7,6,6,7,19,25,2,13 for 15/7')).toEqual({ counts: [7, 6, 6, 7, 19, 25, 2, 13], dateText: '15/7' })
    expect(parseManpower('manpower 7 6 6')?.counts).toEqual([7, 6, 6])
    expect(parseManpower('what was the manpower yesterday?')).toBeNull()
  })

  it('reads banana and cassava estimates in tonnes or kg', () => {
    expect(parseEstimate('banana 11t')).toEqual({ item: 'banana', kg: 11000, dateText: null })
    expect(parseEstimate('Banana approx 11.5 tonnes for 15 July')).toEqual({ item: 'banana', kg: 11500, dateText: '15 July' })
    expect(parseEstimate('banana 9400 kg')).toEqual({ item: 'banana', kg: 9400, dateText: null })
    expect(parseEstimate('banana 11')).toEqual({ item: 'banana', kg: 11000, dateText: null })
    expect(parseEstimate('tapioca 2 t')).toEqual({ item: 'cassava', kg: 2000, dateText: null })
    expect(parseEstimate('banana chips stock?')).toBeNull()
  })

  it('reads report requests and leaves other sentences to the agent', () => {
    expect(parseReportRequest('daily report 15 July', TODAY)).toEqual({ dateText: '15 July' })
    expect(parseReportRequest('DR 15/7', TODAY)).toEqual({ dateText: '15/7' })
    expect(parseReportRequest('report for 8 Oct', TODAY)).toEqual({ dateText: '8 Oct' })
    expect(parseReportRequest('send me the daily report', TODAY)).toEqual({ dateText: null })
    expect(parseReportRequest("yesterday's report", TODAY)).toEqual({ dateText: 'yesterday' })
    expect(parseReportRequest('report the carton shortage to procurement', TODAY)).toBeNull()
    expect(parseReportRequest('what is in the daily report?', TODAY)).toBeNull()
  })

  it('takes the report shortcut only when the day is all that follows', () => {
    expect(parseReportRequest('report yesterday', TODAY)).toEqual({ dateText: 'yesterday' })
    expect(parseReportRequest('DR 15/7.', TODAY)).toEqual({ dateText: '15/7' })
    expect(parseReportRequest('daily report 15th of July 2026', TODAY)).toEqual({ dateText: '15th of July 2026' })
    expect(parseReportRequest('report 2 cartons damaged on 15/7', TODAY)).toBeNull()
    expect(parseReportRequest('report the 15/7 shortage', TODAY)).toBeNull()
    expect(parseReportRequest('report 10 marks', TODAY)).toBeNull()
  })

  it('defaults manpower and estimates to yesterday before noon in India and to today after', () => {
    expect(defaultInputDate(new Date('2026-07-16T06:29:00Z'))).toBe('2026-07-15') // 11:59 IST
    expect(defaultInputDate(new Date('2026-07-16T06:30:00Z'))).toBe('2026-07-16') // 12:00 IST
    expect(defaultInputDate(new Date('2026-07-15T19:00:00Z'))).toBe('2026-07-15') // 00:30 IST on the 16th
  })

  it('finds the day a sentence names without reading quantities as days', () => {
    expect(namedDay('we were 85 on 15/7', TODAY)).toBe('2026-07-15')
    expect(namedDay('banana 11 t yesterday', TODAY)).toBe('2026-10-08')
    expect(namedDay('banana 11.5 tonnes', TODAY)).toBeNull()
    expect(namedDay('counts 7/6/6/7/19/25/2/13', TODAY)).toBeNull()
    expect(namedDay('for 15 July: banana 9 tonnes', TODAY)).toBe('2026-07-15')
    expect(namedDay('10 marks', TODAY)).toBeNull()
  })

  it('spots finance questions an office user does not get answers to', () => {
    expect(isFinanceQuestion('SBI balance?')).toBe(true)
    expect(isFinanceQuestion('what is the bank balance today')).toBe(true)
    expect(isFinanceQuestion('how much are the receivables from Wipro')).toBe(true)
    expect(isFinanceQuestion('payment terms on PO 4400012345?')).toBe(false)
    expect(isFinanceQuestion('stock of cartons')).toBe(false)
  })
})

describe('daily inputs from the tool loop', () => {
  const manpower = { office: 7, qc: 6, operators: 6, gents_unloading: 7, ladies: 19, temp_ladies: 25, security: 2, temporary: 13 }

  // 15 Jul 2026, 13:30 in India: a message naming no day is for the 15th
  const AFTERNOON = new Date('2026-07-15T08:00:00Z')
  const MORNING = new Date('2026-07-16T03:00:00Z')

  it('saves only figures the message itself gives', () => {
    const effect = { kind: 'set_daily_inputs' as const, date: '2026-07-15', patch: { manpower, bananaKgEstimate: 11000 } }
    expect(gateEffects([effect], 'office 7, qc 6, operators 6, gents 7, ladies 19, temp ladies 25, security 2, temporary 13; banana 11 tonnes', AFTERNOON).allowed).toEqual([effect])
    const refused = gateEffects([effect], 'please fill in the usual numbers', AFTERNOON)
    expect(refused.allowed).toEqual([])
    expect(refused.refused[0]).toContain('manpower 7 6 6 7 19 25 2 13')
    expect(gateEffects([{ kind: 'set_daily_inputs', date: '2026-07-15', patch: { packingRun: false } }], 'no packing today', AFTERNOON).allowed).toHaveLength(1)
    expect(gateEffects([{ kind: 'set_daily_inputs', date: '2026-07-15', patch: { packingRun: false } }], 'all good', AFTERNOON).allowed).toHaveLength(0)
    expect(gateEffects([{ kind: 'send_daily_report', date: '2026-07-15' }], 'whatever', AFTERNOON).allowed).toHaveLength(1)
  })

  it('saves for the day the message names, or the default day, and never another', () => {
    const banana = (date: string) => ({ kind: 'set_daily_inputs' as const, date, patch: { bananaKgEstimate: 11000 } })
    expect(gateEffects([banana('2026-07-15')], 'banana 11 tonnes', AFTERNOON).allowed).toHaveLength(1)
    expect(gateEffects([banana('2026-07-15')], 'banana 11 tonnes', MORNING).allowed).toHaveLength(1)
    expect(gateEffects([banana('2026-07-16')], 'banana 11 tonnes', MORNING).refused[0]).toContain('they are for 16 Jul 2026, but your message is for 15 Jul 2026')
    expect(gateEffects([banana('2026-07-12')], 'banana 11 tonnes for 12/7', AFTERNOON).allowed).toHaveLength(1)
    expect(gateEffects([banana('2026-07-14')], 'banana 11 tonnes for 12/7', AFTERNOON).allowed).toHaveLength(0)
  })

  it('saves a note only after "note:", in the message’s own words', () => {
    const note = (notes: string) => ({ kind: 'set_daily_inputs' as const, date: '2026-07-15', patch: { notes } })
    expect(gateEffects([note('Boiler down')], 'boiler was down, add a note', AFTERNOON).allowed).toEqual([])
    expect(gateEffects([note('Boiler down all day')], 'note: boiler down from 10 to 2 on 12/7', AFTERNOON).allowed).toEqual([
      { kind: 'set_daily_inputs', date: '2026-07-15', patch: { notes: 'boiler down from 10 to 2 on 12/7' } },
    ])
    const mixed = gateEffects([{ kind: 'set_daily_inputs', date: '2026-07-15', patch: { packingRun: true, notes: 'x' } }], 'packing ran', AFTERNOON)
    expect(mixed.allowed).toEqual([{ kind: 'set_daily_inputs', date: '2026-07-15', patch: { packingRun: true } }])
    expect(mixed.refused[0]).toContain('write *note:*')
  })
})

describe('the qa role alias', () => {
  it('routes qa to the office', async () => {
    const { roleFromName } = await import('../db/types')
    expect(roleFromName('QA')).toBe('office')
    expect(roleFromName('manager')).toBe('manager')
    expect(roleFromName('cfo')).toBeNull()
  })
})

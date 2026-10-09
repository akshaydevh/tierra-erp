import { describe, expect, it } from 'vitest'
import type { DailyReportInputs } from '../db/types'
import type { BankLine, InwardLine } from '../queries/finance'
import {
  activityFlags,
  defaultReportDate,
  inwardKey,
  inwardRows,
  kgText,
  lineLabel,
  manpowerTotal,
  memoParty,
  parseReportDate,
  reportLines,
  shortPartyName,
  type LabelBook,
} from './daily-report'

const TODAY = '2026-10-09'

function inputs(patch: Partial<DailyReportInputs> = {}): DailyReportInputs {
  return {
    reportDate: '2026-03-22',
    productionRun: null,
    packingRun: null,
    cartoningRun: null,
    manpower: null,
    bananaKgEstimate: null,
    cassavaKgEstimate: null,
    inwardRemarks: {},
    notes: null,
    enteredBy: null,
    enteredByName: null,
    enteredAt: null,
    ...patch,
  }
}

function grn(patch: Partial<InwardLine>): InwardLine {
  return {
    docEntry: 1,
    docNo: 'GR/25-26/1',
    cardCode: 'ZV1',
    cardName: 'Vendor',
    createdAt: null,
    itemCode: 'X',
    itemName: 'X',
    materialRole: 'other',
    qty: 1,
    uom: 'kg',
    value: 0,
    freeIssue: false,
    ...patch,
  }
}

describe('report dates', () => {
  it('reads the ways people write a day, latest on or before today when the year is left out', () => {
    expect(parseReportDate('15 July', TODAY)).toBe('2026-07-15')
    expect(parseReportDate('July 15', TODAY)).toBe('2026-07-15')
    expect(parseReportDate('15/7', TODAY)).toBe('2026-07-15')
    expect(parseReportDate('15/07/2026', TODAY)).toBe('2026-07-15')
    expect(parseReportDate('15-07-26', TODAY)).toBe('2026-07-15')
    expect(parseReportDate('2026-07-15', TODAY)).toBe('2026-07-15')
    expect(parseReportDate('8 Oct', TODAY)).toBe('2026-10-08')
    expect(parseReportDate('25 Dec', TODAY)).toBe('2025-12-25')
    expect(parseReportDate('yesterday', TODAY)).toBe('2026-10-08')
    expect(parseReportDate('today', TODAY)).toBe('2026-10-09')
    expect(parseReportDate('31/2', TODAY)).toBeNull()
    expect(parseReportDate('the stock', TODAY)).toBeNull()
  })

  it('defaults to yesterday in India, or the SAP data date when that is earlier', () => {
    const now = new Date('2026-10-09T05:00:00Z')
    expect(defaultReportDate(now, '2026-10-07')).toBe('2026-10-07')
    expect(defaultReportDate(now, '2026-10-09')).toBe('2026-10-08')
    expect(defaultReportDate(new Date('2026-10-08T20:00:00Z'), null)).toBe('2026-10-08')
  })
})

describe('line labels', () => {
  const book: LabelBook = {
    aliases: new Map([['ZC001', 'Alpha']]),
    glLabels: new Map([
      ['ZGAS', { glCode: 'ZGAS', label: 'Gas', preferPayee: false }],
      ['ZREP', { glCode: 'ZREP', label: 'Repairs', preferPayee: true }],
    ]),
  }
  const base = { contraKind: 'gl' as const, contraBank: null, cardCode: null, contraName: null, contraCode: null, purposeGl: null, paymentMemo: null, memo: null, jeMemo: null }

  it('names transfers, parties by alias, GL accounts by label and the payee when the label prefers it', () => {
    expect(lineLabel({ ...base, contraKind: 'bank', contraBank: 'OMEGA' }, book)).toBe('Transfer ⇄ OMEGA')
    expect(lineLabel({ ...base, contraKind: 'card', cardCode: 'ZC001', contraName: 'Alpha Snacks Pvt Ltd' }, book)).toBe('Alpha')
    expect(lineLabel({ ...base, contraKind: 'card', cardCode: 'ZV002', contraName: 'Gamma Packaging Private Limited' }, book)).toBe('Gamma Packaging')
    expect(lineLabel({ ...base, purposeGl: 'ZGAS', paymentMemo: 'Paid to ramesh - 2 gas cylinders' }, book)).toBe('Gas')
    expect(lineLabel({ ...base, purposeGl: 'ZREP', paymentMemo: 'Paid to suresh for welding work' }, book)).toBe('Suresh')
    expect(lineLabel({ ...base, purposeGl: 'ZREP', paymentMemo: 'Welding work' }, book)).toBe('Repairs')
    expect(lineLabel({ ...base, contraCode: 'ZMISC', contraName: 'Misc Income (TRA)', paymentMemo: 'Bank charges' }, book)).toBe('Misc Income')
    expect(lineLabel({ ...base, contraCode: 'ZX' }, book)).toBe('Unknown')
  })

  it('finds the payee or payer in a memo', () => {
    expect(memoParty('Paid to gireesh for electrical work of plant')).toBe('Gireesh')
    expect(memoParty('Paid to sunil - purchase 2 gas cylinder')).toBe('Sunil')
    expect(memoParty('Payment from Misc Income')).toBe('Misc Income')
    expect(memoParty('Banana unloading charge on 15.07.26 by 5 person')).toBeNull()
    expect(memoParty(null)).toBeNull()
    expect(shortPartyName('Beta Retail LLP')).toBe('Beta Retail')
  })
})

describe('inwards', () => {
  it('sorts received items into the sheet rows and prints the gate estimate beside SAP kg', () => {
    expect(inwardKey({ materialRole: 'raw_banana', itemName: 'Raw Banana', itemCode: 'Z' })).toBe('banana')
    expect(inwardKey({ materialRole: 'consumable', itemName: 'LPG Gas', itemCode: 'Z' })).toBe('gas')
    expect(inwardKey({ materialRole: 'consumable', itemName: 'Diesel', itemCode: 'Z' })).toBe('diesel')
    expect(inwardKey({ materialRole: 'carton', itemName: 'Carton 5 ply', itemCode: 'Z' })).toBe('packing')
    expect(inwardKey({ materialRole: 'other', itemName: 'Caustic soda', itemCode: 'Z' })).toBe('caustic')

    const rows = inwardRows(
      [grn({ materialRole: 'raw_banana', qty: 800, docNo: 'GR/25-26/2' }), grn({ materialRole: 'carton', qty: 400, uom: 'nos' }), grn({ itemName: 'Spanner', qty: 2, uom: 'nos' })],
      inputs({ bananaKgEstimate: 11000, inwardRemarks: { banana: 'one load short' } }),
    )
    expect(rows.map((row) => row.key)).toEqual(['banana', 'cassava', 'oil', 'diesel', 'gas', 'flavour', 'packing', 'laminate', 'caustic', 'other'])
    expect(rows[0]).toMatchObject({ quantity: '11 t (SAP GRPO 800 kg)', remarks: 'one load short', grns: ['GR/25-26/2'] })
    expect(rows.find((row) => row.key === 'packing')?.quantity).toBe('400 nos')
    expect(rows.find((row) => row.key === 'cassava')?.quantity).toBeNull()
    expect(inwardRows([], inputs({ cassavaKgEstimate: 2500 })).find((row) => row.key === 'cassava')?.quantity).toBe('2.5 t (not in SAP yet)')
    expect(inwardRows([], null).some((row) => row.key === 'other')).toBe(false)
    expect(kgText(11000)).toBe('11 t')
    expect(kgText(850)).toBe('850 kg')
  })
})

describe('activity and manpower', () => {
  it('takes production from SAP unless someone entered it', () => {
    const day = { orders: [{ docNo: 'PR/25-26/1', itemCode: 'Z', itemName: null, customer: null, plannedQty: 10, status: 'released' }], receipts: [], issues: [{ role: 'carton', lines: 1, qty: 20 }] }
    expect(activityFlags(day, null)).toMatchObject({
      production: { value: true, source: 'sap' },
      packing: { value: false, source: 'sap' },
      cartoning: { value: true, source: 'sap' },
    })
    expect(activityFlags(day, inputs({ packingRun: true })).packing).toMatchObject({ value: true, source: 'input' })
    expect(activityFlags(null, null).production).toEqual({ value: null, source: null, detail: null })
  })

  it('adds the manpower up', () => {
    expect(manpowerTotal({ office: 7, qc: 6, operators: 6, gents_unloading: 7, ladies: 19, temp_ladies: 25, security: 2, temporary: 13 })).toBe(85)
    expect(manpowerTotal(null)).toBeNull()
  })
})

describe('receipts and payments lists', () => {
  function bankLine(patch: Partial<BankLine>): BankLine {
    return {
      transId: 1, lineId: 0, glCode: 'ZB', bank: 'ZB', refDate: '2026-03-31', reportDate: '2026-03-31', moved: false, createdAt: null,
      debit: 0, credit: 0, amount: 0, contraCode: null, contraKind: 'card', contraBank: null, cardCode: 'ZC9', contraName: 'Kappa Foods',
      transType: '24', paymentDocEntry: null, paymentType: null, paymentMemo: null, paymentCancelled: false, purposeGl: null,
      memo: null, jeMemo: null, sourceNo: '9', isReversal: false, reversesTransId: null, ...patch,
    }
  }
  const book: LabelBook = { aliases: new Map(), glLabels: new Map() }

  it('drops a same-day cancellation pair, keeps a later reversal negative in its column, and adds up to the bank columns', () => {
    const lines = [
      bankLine({ transId: 1, debit: 500, amount: 500 }),
      bankLine({ transId: 2, credit: 300, amount: -300, transType: '46' }),
      bankLine({ transId: 3, credit: -300, amount: 300, transType: '46', isReversal: true, reversesTransId: 2 }),
      bankLine({ transId: 4, debit: -200, amount: -200, isReversal: true, reversesTransId: 99 }),
      bankLine({ transId: 5, credit: 50, amount: -50, transType: '46' }),
    ]
    const { receipts, payments } = reportLines(lines, book)
    expect(receipts.map((line) => [line.label, line.amount])).toEqual([['Kappa Foods', 500], ['cancelled Kappa Foods', -200]])
    expect(payments.map((line) => [line.label, line.amount])).toEqual([['Kappa Foods', 50]])
    const column = (key: 'debit' | 'credit') => lines.reduce((sum, line) => sum + line[key], 0)
    expect(receipts.reduce((sum, line) => sum + line.amount, 0)).toBe(column('debit'))
    expect(payments.reduce((sum, line) => sum + line.amount, 0)).toBe(column('credit'))
  })
})

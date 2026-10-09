import { describe, expect, it } from 'vitest'
import type { CustomerPo, CustomerPoLine, InventoryCheck, InventoryCheckLine } from '../db/types'
import { buildSalesOrder, hsnWarnings, totalMismatch } from './tso'

// Invented numbers in the shape of a retailer PO: line 1 in cartons of 40 with an EA sub-row, line 2 in cartons of 24.

function line(overrides: Partial<CustomerPoLine>): CustomerPoLine {
  return {
    lineNo: 1,
    articleNo: '700100200',
    ean: '8900000000017',
    description: 'ZETA BANANA CHIPS 100 G PP',
    hsn: '21069091',
    qty: 3,
    uom: 'CRT',
    eaQty: 120,
    mrp: 3200,
    baseCost: 1451.33,
    gstPct: 5,
    taxAmount: 217.7,
    lineTotal: 4353.99,
    deliveryDate: null,
    itemCode: 'ZFGA100',
    itemName: 'Zeta Banana Chips 100g',
    matchMethod: 'article',
    matchConfirmed: true,
    pcs: 120,
    pcsSource: 'ea',
    pcsPerUom: 40,
    unitPrice: 36.2833,
    note: null,
    ...overrides,
  }
}

function po(lines: CustomerPoLine[], overrides: Partial<CustomerPo> = {}): CustomerPo {
  return {
    id: 'cpo_1',
    partyGroupId: 'pty_1',
    partyName: 'Northwind',
    poNo: '4400099999',
    revision: 1,
    status: 'checked',
    cardCode: 'ZN05',
    siteCode: 'T9QA',
    shipToGstin: '32AAACN9999Q1ZB',
    shipToAddress: null,
    buyerName: 'Northwind Retail Limited',
    vendorCode: '99887766',
    poDate: '2026-03-20',
    deliveryDate: '2026-04-01',
    basicTotal: null,
    taxTotal: null,
    total: null,
    notes: ['Book a DC slot'],
    deliveryTerm: 'DDP - Delivered Duty Paid',
    paymentTerms: null,
    reader: 'z_mat_poprint',
    resolution: null,
    reviewReason: null,
    repeatOf: [],
    documentId: null,
    sourceChat: null,
    sourceMessageId: null,
    sourceSender: null,
    raisedBy: null,
    createdAt: '2026-03-20T00:00:00Z',
    updatedAt: '2026-03-20T00:00:00Z',
    lines,
    ...overrides,
  }
}

function fg(itemCode: string, need: number, fromStock: number): InventoryCheckLine {
  return {
    kind: 'fg', itemCode, itemName: null, role: 'fg', uom: 'pcs', need, onHand: 0, committed: 0, reserved: 0, adjustments: 0,
    free: fromStock, onOrder: 0, shortNow: 0, shortAfterIncoming: 0, fromStock, toMake: need - fromStock, owner: null,
    ownerCardCode: null, ownerName: null, checked: true, estimated: false, status: 'ok', incoming: [], forItems: [], note: null,
  }
}

const check = (lines: InventoryCheckLine[]): InventoryCheck => ({
  id: 'chk_1', customerPoId: 'cpo_1', kind: 'po', verdict: 'pass', dataAsOf: '2026-03-31', warnings: [], requested: [],
  createdBy: null, createdAt: '2026-03-31T00:00:00Z', lines,
})

const tax = {
  ZFGA100: { hsn: '99990001', gstRate: 5, pcsPerCarton: 40, itemName: 'Zeta Banana Chips 100g' },
  ZFGB200: { hsn: '99990001', gstRate: 5, pcsPerCarton: 24, itemName: 'Zeta Cassava Chips 200g' },
}

describe('buildSalesOrder', () => {
  it('keeps the PO value to the paisa, splits GST inside Kerala and reserves what comes from stock', () => {
    const lines = [line({}), line({ lineNo: 2, articleNo: '700100300', itemCode: 'ZFGB200', qty: 10, uom: 'C01', eaQty: 240, pcs: 240, pcsPerUom: 24, lineTotal: 37848, taxAmount: 1892.4, mrp: 8400, unitPrice: 157.7 })]
    const { order, numbering, problems } = buildSalesOrder({
      po: po(lines),
      check: check([fg('ZFGA100', 120, 120), fg('ZFGB200', 240, 0)]),
      tax,
      cardGstin: null,
      docDate: '2026-04-02',
      createdBy: 'usr_alex',
    })
    expect(problems).toEqual([])
    expect(numbering).toEqual({ series: 'TSO', fy: '26-27' })
    expect(order).toMatchObject({
      taxKind: 'cgst_sgst',
      stateCode: '32',
      placeOfSupply: 'Kerala',
      basicTotal: 42201.99,
      cgst: 1055.05,
      sgst: 1055.05,
      igst: 0,
      taxTotal: 2110.1,
      total: 44312.09,
      deliveryTerm: 'DDP - Delivered Duty Paid',
      vendorCode: '99887766',
      checkId: 'chk_1',
      status: 'pending_approval',
    })
    expect(order.lines.map((row) => [row.itemCode, row.pcs, row.cartons, row.unitPrice, row.amount, row.mrp, row.hsn, row.reservedPcs, row.toMake])).toEqual([
      ['ZFGA100', 120, 3, 36.2833, 4353.99, 80, '99990001', 120, 0],
      ['ZFGB200', 240, 10, 157.7, 37848, 350, '99990001', 0, 240],
    ])
  })

  it('uses IGST outside Kerala and computes tax the PO does not print', () => {
    const { order } = buildSalesOrder({
      po: po([line({ taxAmount: null })], { shipToGstin: '29AABCB5678B1Z2' }),
      check: check([fg('ZFGA100', 120, 0)]),
      tax,
      cardGstin: null,
      docDate: '2027-03-31',
      createdBy: null,
    })
    expect(order).toMatchObject({ taxKind: 'igst', placeOfSupply: 'Karnataka', cgst: 0, sgst: 0, igst: 217.7, total: 4571.69 })
  })

  it('takes the FY from the SO date and flags a PO HSN that differs from SAP for the annex only', () => {
    const { numbering, order } = buildSalesOrder({
      po: po([line({})]),
      check: check([fg('ZFGA100', 120, 50)]),
      tax,
      cardGstin: null,
      docDate: '2027-03-31',
      createdBy: null,
    })
    expect(numbering.fy).toBe('26-27')
    expect(order.lines[0]).toMatchObject({ reservedPcs: 50, toMake: 70 })
    expect(hsnWarnings(order.lines)).toEqual(["Line 1 ZFGA100: PO HSN 21069091 differs from SAP HSN 99990001; the SO prints SAP's."])
    expect(hsnWarnings([{ lineNo: 1, itemCode: 'X', hsn: '9999 0001', poHsn: '99990001' }])).toEqual([])
  })

  it('never guesses Kerala: no GSTIN on the PO or the card blocks the TSO', () => {
    const { problems } = buildSalesOrder({
      po: po([line({})], { shipToGstin: null }),
      check: check([fg('ZFGA100', 120, 0)]),
      tax,
      cardGstin: null,
      docDate: '2026-04-02',
      createdBy: null,
    })
    expect(problems).toEqual(['Neither the PO nor the SAP card has a GSTIN, so the place of supply (CGST + SGST or IGST) is unknown.'])
    // the card's GSTIN is enough
    const fromCard = buildSalesOrder({
      po: po([line({})], { shipToGstin: null }),
      check: check([fg('ZFGA100', 120, 0)]),
      tax,
      cardGstin: '29AABCB5678B1Z2',
      docDate: '2026-04-02',
      createdBy: null,
    })
    expect(fromCard.problems).toEqual([])
    expect(fromCard.order).toMatchObject({ taxKind: 'igst', stateCode: '29' })
  })

  it('carries cess on its own so the TSO adds up to the PO, and warns when they still differ by more than ₹1', () => {
    // 5% GST 217.70 plus a fixed cess of 43.54 printed on the PO line: tax 261.24
    const withCess = line({ taxAmount: 261.24, cessAmount: 43.54 })
    const { order, warnings, problems } = buildSalesOrder({
      po: po([withCess], { total: 4615.23 }),
      check: check([fg('ZFGA100', 120, 0)]),
      tax,
      cardGstin: null,
      docDate: '2026-04-02',
      createdBy: null,
    })
    expect(problems).toEqual([])
    expect(warnings).toEqual([])
    expect(order).toMatchObject({ cgst: 108.85, sgst: 108.85, cess: 43.54, taxTotal: 261.24, total: 4615.23 })
    expect(order.lines[0]).toMatchObject({ taxAmount: 217.7, cessAmount: 43.54 })
    // the PO total carries cess the reader did not split out: the admin is warned, the TSO is still raised
    const unsplit = buildSalesOrder({
      po: po([line({})], { total: 4615.23 }),
      check: check([fg('ZFGA100', 120, 0)]),
      tax,
      cardGstin: null,
      docDate: '2026-04-02',
      createdBy: null,
    })
    expect(unsplit.problems).toEqual([])
    expect(unsplit.warnings).toEqual(['The TSO total ₹4,571.69 differs from the PO total ₹4,615.23 by ₹43.54.'])
    expect(totalMismatch(100.5, 100)).toBeNull()
    expect(totalMismatch(100, null)).toBeNull()
  })
})

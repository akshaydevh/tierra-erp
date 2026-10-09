import pdfParse from 'pdf-parse'
import { afterEach, describe, expect, it } from 'vitest'
import type { SalesOrder } from '../db/types'
import { renderAnnexPdf } from './availability-annex'
import { renderSalesOrderPdf, salesOrderFileName, stampText } from './sales-order'

// Invented order: one line of 120 pieces shipped to Karnataka, so IGST applies.
const order: SalesOrder = {
  id: 'tso_1', docNo: 'TSO/26-27/0007', series: 'TSO', fy: '26-27', seq: 7, version: 2, customerPoId: 'cpo_1', partyGroupId: null,
  partyName: 'Beta Retail', cardCode: 'ZC002', checkId: null, status: 'pending_approval', docDate: '2026-04-02', deliveryDate: '2026-04-10',
  customerPoNo: 'BPO-77', poDate: '2026-03-30', vendorCode: 'V-12', siteCode: 'B01', shipToGstin: '29AABCB5678B1Z2',
  placeOfSupply: 'Karnataka', stateCode: '29', taxKind: 'igst', basicTotal: 4353.99, cgst: 0, sgst: 0, igst: 217.7, taxTotal: 217.7,
  total: 4571.69, deliveryTerm: 'DDP - Delivered Duty Paid', paymentTerms: '30 days', notes: ['Quote the PO number on the invoice.'],
  createdBy: null, approvedBy: null, approvedAt: null, sentAt: null, cess: 0, sapDocEntry: null, sapDocNo: null, cancelledAt: null, createdAt: '2026-04-02T00:00:00Z', updatedAt: '2026-04-02T00:00:00Z',
  lines: [{ lineNo: 1, itemCode: 'ZFGA100', itemName: 'Zeta Banana Chips 100g', description: 'ZETA BANANA CHIPS 100 G', articleNo: '700100200', ean: null, hsn: '99990001', poHsn: '21069091', uom: 'CRT', qty: 3, pcs: 120, pcsPerUom: 40, cartons: 3, mrp: 80, unitPrice: 36.2833, amount: 4353.99, gstPct: 5, taxAmount: 217.7, reservedPcs: 120, toMake: 0 }],
}

describe('sales order PDF', () => {
  afterEach(() => {
    delete process.env.COMPANY_BANK
  })

  it('prints the customer copy with SAP HSN, IGST outside Kerala, words, stamp and bank block', async () => {
    process.env.COMPANY_BANK = 'Test Bank, Test Branch|A/C 000111 · IFSC TEST0000001'
    const pdf = await renderSalesOrderPdf({ order, customer: null, buyerName: 'Beta Retail LLP', stamp: { kind: 'pending' }, now: new Date('2026-04-02T06:00:00Z') })
    const text = (await pdfParse(pdf)).text
    for (const expected of ['SALES ORDER', 'PENDING APPROVAL', 'TSO/26-27/0007 (v2)', 'BPO-77', 'Karnataka (29)', '99990001', 'IGST', '36.2833', '4,571.69', 'Rupees Four Thousand Five Hundred Seventy One and Sixty Nine Paise Only', 'A/C 000111', 'Quote the PO number']) {
      expect(text, expected).toContain(expected)
    }
    expect(text).not.toContain('21069091')
    expect(text).not.toContain('CGST')
    expect(text).not.toContain('Cess')
  })

  it('prints cess on its own line and column when the PO carries it, so the total matches the PO', async () => {
    const withCess: SalesOrder = {
      ...order,
      cess: 43.54,
      taxTotal: 261.24,
      total: 4615.23,
      lines: [{ ...order.lines[0]!, cessAmount: 43.54 }],
    }
    const text = (await pdfParse(await renderSalesOrderPdf({ order: withCess, customer: null, buyerName: null, stamp: { kind: 'pending' }, now: new Date('2026-04-02T06:00:00Z') }))).text
    for (const expected of ['Cess', '43.54', '261.24', '4,615.23']) expect(text, expected).toContain(expected)
  })

  it('names files by number, version and stamp', () => {
    expect(salesOrderFileName('TSO/26-27/0001', 1, 'pending')).toBe('TSO-26-27-0001-v1.pdf')
    expect(salesOrderFileName('TSO/26-27/0001', 2, 'approved')).toBe('TSO-26-27-0001-v2-approved.pdf')
    expect(stampText({ kind: 'approved', by: 'Alex Thomas', at: '2026-04-02T08:32:00Z' })).toBe('APPROVED · Alex Thomas · 02 Apr 2026, 14:02 IST')
    expect(stampText({ kind: 'draft' })).toBe('DRAFT')
  })

  it('prints the internal annex with its warnings', async () => {
    const pdf = await renderAnnexPdf({ order, po: null, check: null, customerName: 'Beta Retail', warnings: ['Line 1 ZFGA100: PO HSN 21069091 differs from SAP HSN 99990001; the SO prints SAP\'s.'], requests: [], tasks: [], now: new Date() })
    const text = (await pdfParse(pdf)).text
    expect(text).toContain('Internal only')
    expect(text).toContain('PO HSN 21069091 differs from SAP HSN 99990001')
  })
})

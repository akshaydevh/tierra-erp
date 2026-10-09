import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkTotals } from '../../domain/po'
import { isZMatPoPrint, parseZMatPoPrint } from './zmat'

// pdf-parse text of a Z_MAT_POPRINT purchase order, rebuilt with invented buyer, codes and amounts.
const FIXTURE = readFileSync(join(__dirname, '..', '..', '..', 'test', 'po', 'zmat-poprint.synthetic.txt'), 'utf8')

describe('Z_MAT_POPRINT reader', () => {
  it('recognises the layout by its Creator or its text', () => {
    expect(isZMatPoPrint(FIXTURE)).toBe(true)
    expect(isZMatPoPrint('Purchase order 123', 'Form Z_MAT_POPRINT EN')).toBe(true)
    expect(isZMatPoPrint('PURCHASE ORDER No: 55 Item Qty Rate')).toBe(false)
  })

  it('reads the header, the delivery block, the totals and the buyer notes', () => {
    const po = parseZMatPoPrint(FIXTURE)!
    expect(po).toMatchObject({
      poNumber: '4400012345',
      poDate: '2026-03-02',
      deliveryDate: '2026-03-10',
      buyerName: 'Northwind Retail Limited',
      buyerCode: 'NWBUY01',
      vendorCode: '99887766',
      siteCode: 'T9QA',
      shipToGstin: '32AAACN9999Q1ZB',
      shipToAddress: 'Distribution Center, Plot 7, Test Industrial Estate, Kalamassery, ERNAKULAM, Kerala - 683104',
      basicTotal: 12744,
      taxTotal: 637.2,
      total: 13381.2,
      notes: ['Mention the PO number on the invoice and the delivery challan.', 'Book a DC slot 24 hrs ahead.'],
    })
    expect(checkTotals(po)).toEqual({ ok: true })
  })

  it('reads a line with its EA sub-row and a line without one', () => {
    const [first, second] = parseZMatPoPrint(FIXTURE)!.lines
    expect(first).toEqual({
      lineNo: 1,
      articleNo: '700100200',
      ean: '8900000000017',
      description: 'ZETA BANANA CHIPS 100 G PP',
      hsn: '20081940',
      qty: 3,
      uom: 'CRT',
      eaQty: 150,
      mrp: 3000,
      eaMrp: 20,
      baseCost: 1248,
      gstPct: 5,
      taxAmount: 187.2,
      lineTotal: 3744,
      deliveryDate: '2026-03-10',
    })
    expect(second).toMatchObject({
      lineNo: 2,
      articleNo: '700100300',
      description: 'ZETA PRM KERELA CASSAVA CHIPS 200G PP',
      qty: 10,
      uom: 'C01',
      eaQty: null,
      mrp: 1500,
      baseCost: 900,
      lineTotal: 9000,
      taxAmount: 450,
    })
  })

  it('gives up (null) when a line does not add up, instead of guessing', () => {
    expect(parseZMatPoPrint(FIXTURE.replace('1,248.00           2.50', '1,284.00           2.50'))).toBeNull()
    expect(parseZMatPoPrint(FIXTURE.replace('Grand Total of Qty', 'Grand total missing'))).toBeNull()
    expect(parseZMatPoPrint(FIXTURE.replace('PO NO.:    4400012345', 'PO:'))).toBeNull()
  })

  it('leaves a misread total to the totals guard', () => {
    const po = parseZMatPoPrint(FIXTURE.replace('Total Order Value :INR13,381.20', 'Total Order Value :INR13,481.20'))!
    expect(po.total).toBe(13481.2)
    expect(checkTotals(po)).toMatchObject({ ok: false })
  })
})

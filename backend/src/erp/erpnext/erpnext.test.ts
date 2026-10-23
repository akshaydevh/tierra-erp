import { describe, expect, it, vi } from 'vitest'
import type { SalesOrder } from '../../db/types'
import { salesOrderDoc } from '../../workflows/erpnext-post'
import { ErpnextClient, ErpnextError, erpnextMessage } from './client'
import { COMPAT, compatView, sapTables } from './compat'

describe('sap compat views', () => {
  const tables = sapTables()

  it('reads every SAP table with its columns from the generated DDL', () => {
    expect(tables.size).toBe(61)
    expect(tables.get('_import')).toEqual([
      ['key', 'text'],
      ['value', 'text'],
    ])
    expect(tables.get('oitm')?.[0]).toEqual(['itemcode', 'text'])
    // constraint lines are not columns
    for (const cols of tables.values()) expect(cols.some(([c]) => /^primary$/i.test(c))).toBe(false)
  })

  it('maps only columns SAP has', () => {
    for (const [table, spec] of Object.entries(COMPAT)) {
      const cols = tables.get(table)
      expect(cols, table).toBeDefined()
      for (const col of Object.keys(spec.cols)) expect(cols?.some(([c]) => c === col), `${table}.${col}`).toBe(true)
    }
  })

  it('casts mapped columns to the SAP type and fills the rest with typed NULLs', () => {
    const view = compatView('t', [['a', 'integer'], ['b', 'text']], { from: 'x', cols: { a: 'x.n' } })
    expect(view).toContain('(x.n)::integer AS "a"')
    expect(view).toContain('NULL::text AS "b"')
    expect(view).toContain('FROM x;')
  })

  it('makes an unmapped SAP table an empty view', () => {
    expect(compatView('owor', [['docentry', 'integer']], undefined)).toContain('WHERE false')
  })

  it('refuses a mapping for a column SAP does not have', () => {
    expect(() => compatView('t', [['a', 'integer']], { from: 'x', cols: { nope: '1' } })).toThrow('SAP has no column nope')
  })
})

describe('ERPNext messages', () => {
  it('reads _server_messages and strips the HTML', () => {
    const body = {
      exc_type: 'ValidationError',
      _server_messages: JSON.stringify([JSON.stringify({ message: 'Item <strong>FG1</strong> is disabled' })]),
    }
    expect(erpnextMessage(body, 'fallback')).toBe('Item FG1 is disabled')
  })

  it('falls back when the body has no message', () => {
    expect(erpnextMessage(null, 'ERPNext answered 500')).toBe('ERPNext answered 500')
  })

  it('throws ErpnextError with the status and exception type', async () => {
    const fetchFn = vi.fn(async () =>
      new Response(JSON.stringify({ exc_type: 'ValidationError', exception: 'bad rate' }), { status: 417 }),
    )
    const client = new ErpnextClient(
      { url: 'http://erp', site: 'erp.localhost', apiKey: 'k', apiSecret: 's', company: 'C' },
      fetchFn as unknown as typeof fetch,
    )
    const error = await client.insert({ doctype: 'Sales Order' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ErpnextError)
    expect(error).toMatchObject({ status: 417, excType: 'ValidationError', message: 'bad rate' })
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Host).toBe('erp.localhost')
    expect((init.headers as Record<string, string>).Authorization).toBe('token k:s')
  })
})

describe('salesOrderDoc', () => {
  const order = {
    id: 'tso-1',
    docNo: 'TSO/26-27/1',
    cardCode: 'C001',
    docDate: '2026-10-23',
    deliveryDate: '2026-10-20',
    customerPoNo: 'PO-9',
    poDate: '2026-10-22',
    taxTotal: 50,
    lines: [{ itemCode: 'FG1', pcs: 3, amount: 100, unitPrice: 33.3333 }],
  } as unknown as SalesOrder
  const doc = salesOrderDoc(order, {
    customer: 'CUST-1',
    warehouse: 'FG - T',
    company: 'Tierra',
    taxAccount: 'Output GST - T',
    user: 'u1',
  })

  it('posts pieces at a rate that keeps the line amount, and submits', () => {
    expect(doc.items).toEqual([{ item_code: 'FG1', qty: 3, rate: 33.333333, delivery_date: '2026-10-23', warehouse: 'FG - T' }])
    expect(doc.docstatus).toBe(1)
  })

  it('never delivers before the order date', () => {
    expect(doc.delivery_date).toBe('2026-10-23')
  })

  it('carries the TSO id for the duplicate check, the PO and the GST', () => {
    expect(doc).toMatchObject({ custom_tierra_ref: 'tso-1', po_no: 'PO-9', customer: 'CUST-1', company: 'Tierra' })
    expect(doc.taxes).toEqual([{ charge_type: 'Actual', account_head: 'Output GST - T', description: 'GST', tax_amount: 50 }])
  })
})

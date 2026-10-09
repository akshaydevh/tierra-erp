import pdfParse from 'pdf-parse'
import { describe, expect, it } from 'vitest'
import type { DailyReportPayload } from '../domain/daily-report'
import { dailyReportDefinition, renderDailyReportPdf } from './daily-report'

const flag = (value: boolean | null) => ({ value, source: 'sap' as const, detail: null })

function payload(patch: Partial<DailyReportPayload> = {}): DailyReportPayload {
  return {
    kind: 'full',
    reportDate: '2026-03-31',
    basis: 'created_window',
    cutoff: '19:30',
    dataAsOf: '2026-03-31',
    generatedAt: '2026-04-01T06:00:00Z',
    activity: { production: flag(true), packing: flag(false), cartoning: flag(null) },
    manpower: { values: { office: 7, qc: 6, operators: 6, gents_unloading: 7, ladies: 19, temp_ladies: 25, security: 2, temporary: 13 }, total: 85 },
    banks: [
      { glCode: 'Z1', bank: 'ZETA', houseBank: true, opening: 10000, receipts: 5000, payments: 1200, closing: 13800 },
      { glCode: 'Z2', bank: 'OMEGA', houseBank: false, opening: 0, receipts: 1.1, payments: 0, closing: 1.1 },
    ],
    receipts: [
      { label: 'Alpha', bank: 'ZETA', amount: 5000, ref: 'RT 11', memo: null, transfer: false, movedFrom: null },
      { label: 'Unknown', bank: 'OMEGA', amount: 1.1, ref: 'RT 13', memo: null, transfer: false, movedFrom: '2026-03-30' },
    ],
    payments: [{ label: 'Transfer ⇄ OMEGA', bank: 'ZETA', amount: 1200, ref: 'RT 12', memo: null, transfer: true, movedFrom: null }],
    inwards: [{ key: 'banana', label: 'Banana', quantity: '11 t (SAP GRPO 9,000 kg)', sapQty: [], estimateKg: 11000, remarks: null, grns: [] }],
    outwards: { rows: [{ label: 'Beta', amount: 1234567, invoices: ['TF/25-26/1'], cardCodes: ['ZC002'] }], total: 1234567, monthToDate: 12345678, monthLabel: 'Mar 2026' },
    notes: 'Boiler serviced',
    missing: [],
    footnotes: ['Outwards: by cut-off.', '* Unknown ₹1.10 (OMEGA, RT 13) is dated 30-03-2026 in SAP and counted on this day.'],
    knownDifferences: ['Receipts may be split on the statement.'],
    ...patch,
  }
}

describe('daily report PDF', () => {
  it('prints the sheet on one A4 page with Indian grouping and the house bank highlighted', async () => {
    const definition = dailyReportDefinition(payload())
    expect(definition.pageSize).toBe('A4')
    expect(JSON.stringify(definition.content)).toContain('"fillColor":"#bde9fb"')
    const { text, numpages } = await pdfParse(await renderDailyReportPdf(payload()))
    expect(numpages).toBe(1)
    for (const expected of ['TIERRA FOOD INDIA PRIVATE LIMITED', 'DAILY REPORT', '31-03-2026', 'Gents', 'Security', '85', '13,800.00', 'Transfer to OMEGA', 'Unknown *', '12,34,567.00', '1,23,45,678.00', '11 t (SAP GRPO 9,000 kg)', 'Notes: Boiler serviced', 'Known differences vs manual sheet']) {
      expect(text).toContain(expected)
    }
  })

  it('prints the inputs-only page and the missing manpower', async () => {
    const { text } = await pdfParse(
      await renderDailyReportPdf(
        payload({ kind: 'inputs_only', banks: [], receipts: [], payments: [], manpower: { values: null, total: null }, footnotes: ['SAP data ends 31 Mar 2026.'] }),
      ),
    )
    expect(text).toContain('SAP data ends 31 Mar 2026.')
    expect(text).toContain('Manpower not entered')
    expect(text).not.toContain('Bank opening balance')
  })
})

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderPdf } from '../pdf/kit'
import { extractPdfPages, readPoText, readPurchaseOrder, toExtractedPo } from './extract'

const ZMAT = readFileSync(join(__dirname, '..', '..', 'test', 'po', 'zmat-poprint.synthetic.txt'), 'utf8')

const env = { openaiBaseUrl: 'https://llm.example/v1', openaiApiKey: 'test-key', openaiModel: 'test-model' }
const noKey = { ...env, openaiApiKey: '' }

const OTHER_LAYOUT = [
  'Acme Mart Pvt Ltd',
  'PURCHASE ORDER',
  'PO Number: AM/PO/7781',
  'Date 05/03/2026',
  'Item  Qty  Rate  Amount',
  'Zeta banana chips 100g  40 pcs  25.00  1000.00',
  'GST 5%  50.00',
  'Total  1050.00',
].join('\n')

/** What a model returns for OTHER_LAYOUT: numbers as strings, a missing field, a date in Indian order. */
const MODEL_JSON = {
  poNumber: 'AM/PO/7781',
  poDate: '05/03/2026',
  buyerName: 'Acme Mart Pvt Ltd',
  taxTotal: '50.00',
  total: '1,050.00',
  lines: [{ description: 'Zeta banana chips 100g', qty: '40', uom: 'pcs', baseCost: 25, gstPct: 5, taxAmount: 50, lineTotal: '1000' }],
}

function modelAnswers(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(body) } }] })))
}

describe('reading a received PDF as a purchase order', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('lets a PDF that is not a PO through untouched, without calling the reader', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    expect(await readPoText({ pages: ['Tax invoice TF/26-27/12 for banana chips, 10 cartons'], creator: null }, env)).toMatchObject({
      kind: 'not_po',
    })
    expect(
      await readPoText({ pages: ['This purchase order is referenced on our statement of account.'], creator: null }, env),
    ).toMatchObject({ kind: 'not_po', reason: 'No PO number on page 1.' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the Z_MAT_POPRINT layout without the model, even with no key', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const read = await readPoText({ pages: [ZMAT], creator: 'Form Z_MAT_POPRINT EN' }, noKey)
    expect(read).toMatchObject({ kind: 'po', reader: 'z_mat_poprint', po: { poNumber: '4400012345', total: 13381.2 } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('sends a Z_MAT_POPRINT PO whose totals do not add up to review', async () => {
    const broken = ZMAT.replace('Total Order Value :INR13,381.20', 'Total Order Value :INR13,481.20')
    const read = await readPoText({ pages: [broken], creator: null }, noKey)
    expect(read).toMatchObject({ kind: 'unreadable', poNumber: '4400012345', reader: 'z_mat_poprint' })
    expect(read.kind === 'unreadable' && read.reason).toContain('not the PO total 13481.20')
  })

  it('needs the AI reader for any other layout and goes to review without a key', async () => {
    const read = await readPoText({ pages: [OTHER_LAYOUT], creator: null }, noKey)
    expect(read).toEqual({
      kind: 'unreadable',
      reason: 'This PO layout needs the AI reader, and no OpenAI key is configured.',
      poNumber: 'AM/PO/7781',
      reader: 'llm',
    })
  })

  it('reads another layout with the model into the v2 shape, through the totals guard', async () => {
    const fetchMock = modelAnswers(MODEL_JSON)
    vi.stubGlobal('fetch', fetchMock)
    const read = await readPoText({ pages: [OTHER_LAYOUT], creator: null }, env)
    expect(read).toMatchObject({
      kind: 'po',
      reader: 'llm',
      po: {
        poNumber: 'AM/PO/7781',
        poDate: '2026-03-05',
        siteCode: null,
        total: 1050,
        lines: [{ lineNo: 1, qty: 40, uom: 'pcs', eaQty: null, lineTotal: 1000, articleNo: null }],
      },
    })
    const sent = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as {
      messages: Array<{ content: string }>
    }
    expect(sent.messages[1]?.content).toContain('AM/PO/7781')

    vi.stubGlobal('fetch', modelAnswers({ ...MODEL_JSON, total: '1500' }))
    expect(await readPoText({ pages: [OTHER_LAYOUT], creator: null }, env)).toMatchObject({ kind: 'unreadable', reader: 'llm' })
  })

  it('turns a failing or silent reader into a review, and gives it 90 s', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    expect(await readPoText({ pages: [OTHER_LAYOUT], creator: null }, env)).toMatchObject({
      kind: 'unreadable',
      reason: 'The purchase order reader failed (503).',
    })
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
      }),
    )
    expect(await readPoText({ pages: [OTHER_LAYOUT], creator: null }, env)).toMatchObject({
      reason: 'The purchase order reader did not answer.',
    })
    expect(timeout).toHaveBeenCalledWith(90_000)
    timeout.mockRestore()
  })

  it('rejects model JSON that does not fit the schema', () => {
    expect(() => toExtractedPo({ poNumber: 'X1', lines: [] })).toThrow('The purchase order could not be read.')
    expect(() => toExtractedPo({ poNumber: 'X1', lines: [{ description: 'chips', qty: 0 }] })).toThrow()
  })

  it('reads the text of pages 1-2 of a real PDF and ignores the terms after them', async () => {
    const pdf = await renderPdf({
      content: [
        { text: 'Acme Mart Pvt Ltd' },
        { text: 'PURCHASE ORDER   PO Number: AM/PO/7781', pageBreak: 'after' },
        { text: 'Item list page', pageBreak: 'after' },
        { text: 'General conditions of purchase' },
      ],
    })
    const text = await extractPdfPages(pdf)
    expect(text.pages).toHaveLength(2)
    expect(text.pages[0]).toContain('PO Number: AM/PO/7781')
    expect(text.pages.join('\n')).not.toContain('General conditions')
    expect(await readPurchaseOrder(pdf, noKey)).toMatchObject({ kind: 'unreadable', poNumber: 'AM/PO/7781' })
    expect(await readPurchaseOrder(Buffer.from('not a pdf'), noKey)).toMatchObject({ kind: 'unreadable', reason: 'The PDF could not be opened.' })
  })
})

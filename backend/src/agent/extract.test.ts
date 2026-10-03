import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtractError, extractPurchaseOrder } from './extract'

const pdf = vi.hoisted(() => ({
  text: 'Beyond Snack purchase order PO-100 banana chips quantity 10 pouches',
}))

vi.mock('pdf-parse', () => ({
  default: async () => ({ text: pdf.text }),
}))

const env = {
  openaiBaseUrl: 'https://llm.example/v1',
  openaiApiKey: 'test-key',
  openaiModel: 'test-model',
}

describe('extractPurchaseOrder', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a PDF that does not say purchase order before calling the reader', async () => {
    pdf.text = 'Delivery challan for banana chips, quantity 10 pouches, not an order document'
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const error = await extractPurchaseOrder(Buffer.from('%PDF'), env).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ExtractError)
    expect((error as ExtractError).message).toBe('This PDF is not a purchase order. No order was created.')
    expect(fetchMock).not.toHaveBeenCalled()
    pdf.text = 'Beyond Snack purchase order PO-100 banana chips quantity 10 pouches'
  })

  it('throws ExtractError when the model returns a non-200 response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
    const error = await extractPurchaseOrder(Buffer.from('%PDF'), env).then(
      () => null,
      (caught: unknown) => caught,
    )
    expect(error).toBeInstanceOf(ExtractError)
    expect((error as ExtractError).message).toBe(
      'The purchase order reader failed (503). No order was created.',
    )
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtractError, extractPurchaseOrder } from './extract'

vi.mock('pdf-parse', () => ({
  default: async () => ({ text: 'Beyond Snack purchase order PO-100 banana chips quantity 10 pouches' }),
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

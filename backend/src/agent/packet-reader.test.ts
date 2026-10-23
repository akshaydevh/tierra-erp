import { afterEach, describe, expect, it, vi } from 'vitest'
import { PhotoReadError, describePhoto, readPhoto, toPhotoRead } from './packet-reader'

const ENV = { openaiBaseUrl: 'https://llm.test/v1', openaiApiKey: 'key', openaiVisionModel: 'gpt-4o-mini', openaiReasoningEffort: 'low' as const }

describe('the photo reader', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loosens the model JSON into fixed fields', () => {
    const read = toPhotoRead({
      kind: 'packet',
      quality: 'clear',
      brand: 'Kappo',
      product: 'Banana Chips Classic Salted',
      packSize: '65 g',
      batchNo: 'kbcs 07i26',
      batchNoDoubts: ['7th character: I or 1'],
      mfgDate: '07/09/26',
      expDate: '',
      mrp: 20,
    })
    expect(read).toMatchObject({ kind: 'packet', batchNo: 'KBCS07I26', expDate: null, mrp: '20', bestBefore: null })
    expect(describePhoto(read)).toBe(
      [
        'A product packet (photo clear). Printed on it:',
        '- Brand: Kappo',
        '- Product: Banana Chips Classic Salted',
        '- Pack size: 65 g',
        '- Batch code as read: KBCS07I26',
        '- Unsure characters: 7th character: I or 1',
        '- MFG date: 07/09/26',
        '- MRP: 20',
      ].join('\n'),
    )
  })

  it('says when a photo is not a packet or shows no code', () => {
    expect(describePhoto(toPhotoRead({ kind: 'selfie', notes: 'a person in a factory' }))).toBe(
      'The photo is not a product packet: a person in a factory.',
    )
    expect(describePhoto(toPhotoRead({ kind: 'packet', quality: 'partial', brand: 'Kappo' }))).toContain('- Batch code as read: not visible')
  })

  it('sends the image to the vision model and reads its JSON', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"kind":"packet","quality":"clear","batchNo":"TFB09J24-B"}\n```' } }] })),
    )
    vi.stubGlobal('fetch', fetchMock)
    const read = await readPhoto(Buffer.from('jpeg-bytes'), 'image/jpeg', ENV)
    expect(read.batchNo).toBe('TFB09J24-B')
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, any>
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`)
  })

  it('fails plainly without a key or on a model error', async () => {
    await expect(readPhoto(Buffer.from('x'), 'image/jpeg', { ...ENV, openaiApiKey: '' })).rejects.toBeInstanceOf(PhotoReadError)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(readPhoto(Buffer.from('x'), 'image/jpeg', ENV)).rejects.toThrow('The photo reader failed (500).')
  })
})

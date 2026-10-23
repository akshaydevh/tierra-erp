import { afterEach, describe, expect, it, vi } from 'vitest'
import { HairnetCheckError, checkHairnet, toHairnetCheck } from './hairnet'

const ENV = { openaiBaseUrl: 'https://llm.test/v1', openaiApiKey: 'key', openaiVisionModel: 'gpt-4o-mini', openaiReasoningEffort: 'low' as const }

function answer(content: unknown, message: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content), ...message } }] }))
}

describe('the hairnet check', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loosens the model JSON into fixed fields', () => {
    const check = toHairnetCheck({
      verdict: 'wearing',
      headwear: 'mesh cap',
      hair_fully_covered: false,
      confidence: '0.9',
      reason: ' Blue mesh net over the crown; fringe escaping. ',
      people_count: 1.2,
      head_box: { x: 0.8, y: -0.1, width: 0.4, height: 0.5 },
    })
    expect(check).toEqual({
      verdict: 'wearing',
      headwear: 'not_visible',
      hairFullyCovered: false,
      confidence: 0.9,
      reason: 'Blue mesh net over the crown; fringe escaping.',
      peopleCount: 1,
      headBox: { x: 0.8, y: 0, width: expect.closeTo(0.2), height: 0.5 },
    })
  })

  it('drops hair cover unless wearing, and a box with nothing in frame', () => {
    const check = toHairnetCheck({ verdict: 'not_wearing', headwear: 'none', hair_fully_covered: true, confidence: 7, head_box: { x: 2, y: 0, width: 1, height: 1 } })
    expect(check).toMatchObject({ hairFullyCovered: null, confidence: 1, headBox: null, reason: '' })
    expect(() => toHairnetCheck({ verdict: 'maybe' })).toThrow(HairnetCheckError)
  })

  it('sends the frame to the vision model and reads its JSON', async () => {
    const fetchMock = vi.fn(async () => answer('```json\n{"verdict":"no_person","headwear":"not_visible","confidence":0.95,"reason":"Empty room.","people_count":0,"head_box":null}\n```'))
    vi.stubGlobal('fetch', fetchMock)
    const check = await checkHairnet(Buffer.from('jpeg-bytes'), ENV)
    expect(check).toMatchObject({ verdict: 'no_person', peopleCount: 0, headBox: null })
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, any>
    expect(body.model).toBe('gpt-4o-mini')
    expect(body.response_format).toEqual({ type: 'json_object' })
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${Buffer.from('jpeg-bytes').toString('base64')}`)
  })

  it('fails plainly without a key, on a refusal or on a model error', async () => {
    await expect(checkHairnet(Buffer.from('x'), { ...ENV, openaiApiKey: '' })).rejects.toBeInstanceOf(HairnetCheckError)
    vi.stubGlobal('fetch', vi.fn(async () => answer('', { refusal: 'no' })))
    await expect(checkHairnet(Buffer.from('x'), ENV)).rejects.toThrow('declined')
    vi.stubGlobal('fetch', vi.fn(async () => answer('not json')))
    await expect(checkHairnet(Buffer.from('x'), ENV)).rejects.toThrow('did not return JSON')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('slow down', { status: 429 })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(checkHairnet(Buffer.from('x'), ENV)).rejects.toThrow('rate limited')
  })
})

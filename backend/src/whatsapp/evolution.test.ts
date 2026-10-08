import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpEvolution, groupsFrom } from './evolution'

const env = {
  evolutionUrl: 'http://evolution.internal:8080/',
  evolutionApiKey: 'key-123',
  webhookUrl: 'http://api.internal:3001/',
  webhookSecret: 'secret-xyz',
}

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown }

function mockFetch(responses: unknown[]): Call[] {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      })
      const next = responses.shift() ?? {}
      return new Response(JSON.stringify(next), { status: 200 })
    }),
  )
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const webhook = {
  enabled: true,
  url: 'http://api.internal:3001/webhooks/evolution',
  byEvents: false,
  base64: false,
  events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'],
  headers: { 'x-webhook-secret': 'secret-xyz' },
}

describe('HttpEvolution', () => {
  it('sends a document with sendMedia', async () => {
    const calls = mockFetch([
      { key: { remoteJid: '919812345678@s.whatsapp.net', fromMe: true, id: '3EB0MEDIA01' }, status: 'PENDING' },
    ])
    const sent = await new HttpEvolution(env).sendMedia({
      number: '919812345678',
      mediatype: 'document',
      mimetype: 'application/pdf',
      fileName: 'test.pdf',
      caption: 'Test document',
      media: 'data:application/pdf;base64,JVBERi0xLjQ=',
    })
    expect(sent).toEqual({ messageId: '3EB0MEDIA01' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://evolution.internal:8080/message/sendMedia/tierra')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.headers.apikey).toBe('key-123')
    expect(calls[0]?.body).toEqual({
      number: '919812345678',
      mediatype: 'document',
      mimetype: 'application/pdf',
      fileName: 'test.pdf',
      caption: 'Test document',
      media: 'JVBERi0xLjQ=',
    })
  })

  it('passes an https media URL through untouched', async () => {
    const calls = mockFetch([{}])
    const sent = await new HttpEvolution(env).sendMedia({
      number: '120363025246125486@g.us',
      mediatype: 'image',
      mimetype: 'image/png',
      fileName: 'chart.png',
      media: 'https://files.example.com/chart.png',
    })
    expect(sent).toEqual({ messageId: null })
    expect(calls[0]?.body).toEqual({
      number: '120363025246125486@g.us',
      mediatype: 'image',
      mimetype: 'image/png',
      fileName: 'chart.png',
      media: 'https://files.example.com/chart.png',
    })
  })

  it('lists groups without participants', async () => {
    const calls = mockFetch([
      [
        {
          id: '120363025246125486@g.us',
          subject: 'Tierra x Lulu Procurement',
          subjectOwner: '919800000009@s.whatsapp.net',
          size: 7,
          creation: 1714000000,
          restrict: false,
          announce: false,
        },
        { id: '120363000000000001@g.us', subject: '', size: 3 },
      ],
    ])
    const groups = await new HttpEvolution(env).fetchAllGroups()
    expect(calls[0]?.url).toBe('http://evolution.internal:8080/group/fetchAllGroups/tierra?getParticipants=false')
    expect(calls[0]?.method).toBe('GET')
    expect(groups).toEqual([
      { id: '120363025246125486@g.us', subject: 'Tierra x Lulu Procurement', size: 7 },
      { id: '120363000000000001@g.us', subject: '120363000000000001@g.us', size: 3 },
    ])
  })

  it('points the webhook at the backend without deleting the instance', async () => {
    const calls = mockFetch([{ webhook: { enabled: true } }])
    await new HttpEvolution(env).ensureWebhook()
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('http://evolution.internal:8080/webhook/set/tierra')
    expect(calls[0]?.method).toBe('POST')
    expect(calls[0]?.body).toEqual({ webhook })
  })

  it('creates the instance with base64 off in the webhook', async () => {
    const calls = mockFetch([{}, { qrcode: { base64: 'data:image/png;base64,QQ==' } }, {}])
    const created = await new HttpEvolution(env).createInstance()
    expect(created.qrBase64).toBe('data:image/png;base64,QQ==')
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      'DELETE http://evolution.internal:8080/instance/delete/tierra',
      'POST http://evolution.internal:8080/instance/create',
      'POST http://evolution.internal:8080/webhook/set/tierra',
    ])
    expect((calls[1]?.body as { webhook: unknown }).webhook).toEqual(webhook)
  })

  it('surfaces gateway errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 502 })))
    await expect(new HttpEvolution(env).fetchAllGroups()).rejects.toThrow('502')
  })
})

describe('groupsFrom', () => {
  it('tolerates wrapped lists and other field names', () => {
    expect(
      groupsFrom({
        groups: [
          { jid: '1203630@g.us', name: 'Dispatch', participants: [{ id: 'a' }, { id: 'b' }] },
          { id: '919812345678@s.whatsapp.net', subject: 'not a group' },
          null,
        ],
      }),
    ).toEqual([{ id: '1203630@g.us', subject: 'Dispatch', size: 2 }])
    expect(groupsFrom({ data: [{ id: '9@g.us', subject: 'X', participantsCount: 4 }] })).toEqual([
      { id: '9@g.us', subject: 'X', size: 4 },
    ])
    expect(groupsFrom('nope')).toEqual([])
  })
})

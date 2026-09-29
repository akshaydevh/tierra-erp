import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from './auth/password'
import { createApp, type AppDeps } from './app'
import { DEV_PASSWORD } from './db/seed-data'
import { MemoryStore } from './db/memory'
import { ExtractError } from './agent/extract'
import type { JudgeInput, JudgeResult } from './agent/judge'
import type { ChatInput } from './agent/reply'
import type { ExtractedPo } from './domain/intake'
import type { EvolutionClient } from './whatsapp/evolution'

class FakeEvolution implements EvolutionClient {
  sent: Array<{ number: string; text: string }> = []
  reactions: Array<{ remoteJid: string; messageId: string; fromMe: boolean; emoji: string }> = []
  created = 0
  deleted = 0
  failCreate = false
  failDownload = false
  private sentCount = 0

  async createInstance() {
    if (this.failCreate) throw new Error('down')
    this.created += 1
    return { qrBase64: 'data:image/png;base64,QQ==' }
  }

  async deleteInstance() {
    this.deleted += 1
  }

  async sendText(number: string, text: string) {
    this.sent.push({ number, text })
    this.sentCount += 1
    return { messageId: `out-${this.sentCount}` }
  }

  async sendReaction(remoteJid: string, messageId: string, fromMe: boolean, emoji: string) {
    this.reactions.push({ remoteJid, messageId, fromMe, emoji })
  }

  async downloadMedia() {
    if (this.failDownload) throw new Error('Evolution did not return media')
    return {
      base64: Buffer.from('purchase-order').toString('base64'),
      mimeType: 'application/pdf',
      fileName: 'po.pdf',
    }
  }
}

const secret = 'test-webhook-secret'
const now = new Date('2026-09-26T09:00:00.000Z')

function pdfBody(id: string, jid = '919812345678@s.whatsapp.net') {
  return {
    event: 'MESSAGES_UPSERT',
    instance: 'tierra',
    data: {
      key: { id, remoteJid: jid, fromMe: false },
      message: { documentMessage: { mimetype: 'application/pdf', fileName: 'po.pdf' } },
    },
  }
}

async function setup() {
  const store = new MemoryStore(await hashPassword(DEV_PASSWORD))
  const evolution = new FakeEvolution()
  let extracted: ExtractedPo = {
    customerName: 'Beyond Snack',
    poNumber: 'PO-WA-1',
    poDate: '2026-09-01',
    lines: [
      {
        description: 'Banana chips 40g',
        quantity: 10,
        unit: 'pouch',
        buyerCode: 'BAN-40G',
        price: 12.5,
      },
    ],
  }
  let extractCalls = 0
  let extractError: Error | null = null
  let judged: JudgeResult = { intent: 'conversation', confidence: 1 }
  let judgeError: Error | null = null
  let judgeCalls = 0
  let lastJudge: JudgeInput | null = null
  let chatCalls = 0
  let lastChat: ChatInput | null = null
  const deps: AppDeps = {
    store,
    evolution,
    extractPurchaseOrder: async () => {
      extractCalls += 1
      if (extractError) throw extractError
      return extracted
    },
    judgeIntent: async (input) => {
      judgeCalls += 1
      lastJudge = input
      if (judgeError) throw judgeError
      return judged
    },
    completeChat: async (input) => {
      chatCalls += 1
      lastChat = input
      if (input.snapshot) {
        const row = input.snapshot.inventory.find((item) => item.sku === 'BAN-80G')
        return `Banana chips 80g available ${row?.available ?? 'unknown'}.`
      }
      return 'Tierra Bot here.'
    },
    now: () => now,
    webhookSecret: secret,
    sessionTtlMs: 60_000,
  }
  return {
    app: createApp(deps),
    store,
    evolution,
    setExtracted(next: ExtractedPo) {
      extracted = next
    },
    failExtract(error: Error) {
      extractError = error
    },
    extractCalls: () => extractCalls,
    setJudged(next: JudgeResult) {
      judged = next
    },
    failJudge(error: Error) {
      judgeError = error
    },
    judgeCalls: () => judgeCalls,
    lastJudge: () => lastJudge,
    chatCalls: () => chatCalls,
    lastChat: () => lastChat,
  }
}

async function login(app: ReturnType<typeof createApp>, email: string) {
  const response = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: DEV_PASSWORD }),
  })
  expect(response.status).toBe(200)
  const header = response.headers.get('set-cookie') ?? ''
  const token = header.match(/tierra_session=([^;]+)/)?.[1]
  return `tierra_session=${token}`
}

describe('auth and preview reads', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  it('rejects a bad password and accepts a seeded user', async () => {
    expect((await ctx.app.request('/api/inventory')).status).toBe(401)
    expect((await ctx.app.request('/api/orders/ord_bs_1042')).status).toBe(401)
    const bad = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'joshy@tierra.test', password: 'nope' }),
    })
    expect(bad.status).toBe(401)

    const cookie = await login(ctx.app, 'joshy@tierra.test')
    const me = await ctx.app.request('/api/auth/me', { headers: { cookie } })
    expect(me.status).toBe(200)
    const body = (await me.json()) as { user: { name: string; role: string } }
    expect(body.user.name).toBe('Joshy')
    expect(body.user.role).toBe('admin')
  })

  it('reports reserved stock and the overdrawn 80g line', async () => {
    const cookie = await login(ctx.app, 'anju@tierra.test')
    const response = await ctx.app.request('/api/inventory', { headers: { cookie } })
    const body = (await response.json()) as {
      items: Array<{ sku: string; onHand: number; reserved: number; available: number }>
    }
    const eighty = body.items.find((item) => item.sku === 'BAN-80G')
    expect(eighty).toMatchObject({ onHand: 40, reserved: 100, available: -60 })
    const centre = await ctx.app.request('/api/command-centre', { headers: { cookie } })
    const summary = (await centre.json()) as { openOrders: number; shortLines: number }
    expect(summary.openOrders).toBe(3)
    expect(summary.shortLines).toBe(1)
  })

  it('lets an admin start pairing and blocks the office role', async () => {
    const office = await login(ctx.app, 'anju@tierra.test')
    const denied = await ctx.app.request('/api/whatsapp/pair', { method: 'POST', headers: { cookie: office } })
    expect(denied.status).toBe(403)

    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const paired = await ctx.app.request('/api/whatsapp/pair', { method: 'POST', headers: { cookie: admin } })
    expect(paired.status).toBe(200)
    const body = (await paired.json()) as { connection: { status: string; qrBase64: string } }
    expect(body.connection.status).toBe('qr_pending')
    expect(body.connection.qrBase64.startsWith('data:image')).toBe(true)
    expect(ctx.evolution.created).toBe(1)
  })
})

describe('whatsapp purchase orders', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  async function post(body: unknown, header = secret) {
    return ctx.app.request('/webhooks/evolution', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': header },
      body: JSON.stringify(body),
    })
  }

  it('rejects a webhook without the shared secret', async () => {
    const response = await post(pdfBody('m1'), 'wrong')
    expect(response.status).toBe(401)
  })

  it('creates an order when stock covers the PDF and ignores a repeat webhook', async () => {
    const first = await post(pdfBody('m-create'))
    expect(first.status).toBe(200)
    expect(ctx.extractCalls()).toBe(1)
    expect(ctx.evolution.reactions).toEqual([
      { remoteJid: '919812345678@s.whatsapp.net', messageId: 'm-create', fromMe: false, emoji: '👀' },
    ])
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.sent[0]?.text).toContain('Tierra Bot')
    expect(ctx.evolution.sent[0]?.text).toContain('Created order')
    expect(ctx.evolution.sent[0]?.text).toContain('PO-WA-1')
    expect(ctx.evolution.sent[0]?.number).toBe('919812345678')

    const second = await post(pdfBody('m-create'))
    expect(second.status).toBe(200)
    expect(ctx.extractCalls()).toBe(1)
    expect(ctx.evolution.sent).toHaveLength(1)

    const cookie = await login(ctx.app, 'joshy@tierra.test')
    const orders = await ctx.app.request('/api/orders', { headers: { cookie } })
    const listed = (await orders.json()) as { orders: Array<{ poNumber: string; source: string; id: string }> }
    const created = listed.orders.find((order) => order.poNumber === 'PO-WA-1')
    expect(created?.source).toBe('whatsapp')
    const document = await ctx.app.request(`/api/orders/${created?.id}/document`, { headers: { cookie } })
    expect(document.status).toBe(200)
    expect(document.headers.get('content-type')).toBe('application/pdf')
  })

  it('does not create an order when stock is short', async () => {
    ctx.setExtracted({
      customerName: 'Beyond Snack',
      poNumber: 'PO-SHORT',
      poDate: null,
      lines: [
        {
          description: 'Banana chips 80g',
          quantity: 200,
          unit: 'pouch',
          buyerCode: 'BAN-80G',
          price: null,
        },
      ],
    })
    const response = await post(pdfBody('m-short'))
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent[0]?.text).toContain('requested 200')
    expect(ctx.evolution.sent[0]?.text).toContain('available -60')
    expect(ctx.evolution.sent[0]?.text).toContain('No order was created')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)
    expect(ctx.store.documents).toHaveLength(0)
  })

  it('replies to a personal text and ignores a group PDF', async () => {
    const text = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'm-text', remoteJid: '919800000000@s.whatsapp.net', fromMe: false },
        message: { conversation: 'hello' },
      },
    })
    expect(text.status).toBe(200)
    expect(ctx.evolution.reactions.map((row) => row.emoji)).toEqual(['👀'])
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.sent[0]?.text).toBe('Tierra Bot here.')
    expect(ctx.lastChat()?.snapshot).toBeNull()
    expect(ctx.store.messages.some((row) => row.evolutionMessageId === 'm-text')).toBe(true)

    const group = await post(pdfBody('m-group', '120363000@g.us'))
    expect(group.status).toBe(200)
    expect(ctx.extractCalls()).toBe(0)
    expect(ctx.store.messages.some((row) => row.evolutionMessageId === 'm-group')).toBe(false)
  })

  it('stores the PDF and replies when extraction fails', async () => {
    ctx.failExtract(new ExtractError('The purchase order reader failed (503). No order was created.'))
    const response = await post(pdfBody('m-extract-fail'))
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.sent[0]?.text).toContain('failed (503)')
    expect(ctx.store.messages.some((row) => row.evolutionMessageId === 'm-extract-fail')).toBe(true)
    expect(ctx.store.documents).toHaveLength(1)
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-WA-1')).toBe(false)
  })

  it('replies and keeps the message when the PDF cannot be downloaded', async () => {
    ctx.evolution.failDownload = true
    const response = await post(pdfBody('m-download-fail'))
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent[0]?.text).toBe('Tierra Bot: The PDF could not be downloaded. No order was created.')
    expect(ctx.extractCalls()).toBe(0)
    expect(ctx.store.messages.some((row) => row.evolutionMessageId === 'm-download-fail')).toBe(true)
    expect(ctx.store.documents).toHaveLength(0)
  })
})

const SELF = '919900000000@s.whatsapp.net'
const GROUP = '120363000@g.us'

function textMessage(id: string, remoteJid: string, text: string, fromMe = false) {
  return {
    event: 'messages.upsert',
    instance: 'tierra',
    data: {
      key: { id, remoteJid, fromMe },
      message: { conversation: text },
    },
  }
}

describe('tierra bot', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: '919900000000', qrBase64: null })
  })

  async function post(body: unknown) {
    return ctx.app.request('/webhooks/evolution', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(body),
    })
  }

  it('answers a self-chat stock question from the dashboard and ignores its own echo', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.9 })
    const first = await post(textMessage('user-1', SELF, 'how much stock is left', true))
    expect(first.status).toBe(200)
    expect(ctx.evolution.reactions).toEqual([
      { remoteJid: SELF, messageId: 'user-1', fromMe: true, emoji: '👀' },
    ])
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.sent[0]?.number).toBe('919900000000')
    expect(ctx.evolution.sent[0]?.text).toContain('available -60')
    expect(ctx.lastJudge()?.chatKind).toBe('self')
    expect(ctx.lastChat()?.snapshot?.inventory.some((row) => row.sku === 'BAN-80G')).toBe(true)
    expect(ctx.lastChat()?.snapshot?.emptyModules).toContain('My Day')

    const echo = await post(textMessage('out-1', SELF, 'Banana chips 80g available -60.', true))
    expect(echo.status).toBe(200)
    expect(ctx.judgeCalls()).toBe(1)
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.reactions).toHaveLength(1)
  })

  it('does not include dashboard records when a customer chat asks about stock', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.9 })
    await post(textMessage('cust-1', '919800000000@s.whatsapp.net', 'what is your stock'))
    expect(ctx.lastChat()?.snapshot).toBeNull()
    expect(ctx.evolution.sent[0]?.text).toBe('Tierra Bot here.')
  })

  it('ignores the owner writing in someone else\'s chat', async () => {
    const response = await post(textMessage('own-1', '919800000000@s.whatsapp.net', 'on my way', true))
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.evolution.reactions).toHaveLength(0)
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('answers a group message that names Tierra Bot and keeps the quoted text', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.8 })
    const response = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'g-name', remoteJid: GROUP, fromMe: false },
        message: {
          extendedTextMessage: {
            text: 'Tierra Bot, how many orders are open?',
            contextInfo: { quotedMessage: { conversation: 'the 80g line is short' } },
          },
        },
      },
    })
    expect(response.status).toBe(200)
    expect(ctx.lastJudge()).toMatchObject({
      chatKind: 'group',
      text: 'Tierra Bot, how many orders are open?',
      quotedText: 'the 80g line is short',
    })
    expect(ctx.lastChat()?.quotedText).toBe('the 80g line is short')
    expect(ctx.lastChat()?.snapshot?.commandCentre.openOrders).toBe(3)
    expect(ctx.evolution.sent[0]?.number).toBe(GROUP)
  })

  it('answers a group message that mentions the connected number', async () => {
    const response = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'g-number', remoteJid: GROUP, fromMe: false },
        message: {
          extendedTextMessage: {
            text: 'can you check this',
            contextInfo: { mentionedJid: ['919900000000@s.whatsapp.net'] },
          },
        },
      },
    })
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.lastJudge()?.chatKind).toBe('group')
    expect(ctx.judgeCalls()).toBe(1)
  })

  it('answers a group @mention written in the text', async () => {
    await post(textMessage('g-at', GROUP, '@919900000000 what is left'))
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.lastJudge()?.chatKind).toBe('group')
  })

  it('ignores a group message that does not mention Tierra Bot', async () => {
    await post(textMessage('g-plain', GROUP, 'how much stock is left'))
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.store.messages).toHaveLength(0)
  })

  it('reads a purchase order when the group message mentions Tierra Bot', async () => {
    const response = await post({
      event: 'MESSAGES_UPSERT',
      instance: 'tierra',
      data: {
        key: { id: 'g-pdf', remoteJid: GROUP, fromMe: false },
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: {
                mimetype: 'application/pdf',
                fileName: 'po.pdf',
                caption: 'tierra bot please read this',
              },
            },
          },
        },
      },
    })
    expect(response.status).toBe(200)
    expect(ctx.extractCalls()).toBe(1)
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.evolution.sent[0]?.text).toContain('Created order')
    expect(ctx.evolution.sent[0]?.number).toBe(GROUP)
    expect(ctx.evolution.reactions[0]?.emoji).toBe('👀')
  })

  it('asks for a PDF instead of creating an order from text', async () => {
    ctx.setJudged({ intent: 'needs_pdf', confidence: 0.95 })
    await post(textMessage('need-pdf', SELF, 'create an order for Beyond Snack', true))
    expect(ctx.extractCalls()).toBe(0)
    expect(ctx.chatCalls()).toBe(0)
    expect(ctx.evolution.sent[0]?.text).toContain('purchase-order PDF')
    expect(ctx.store.orders.some((order) => order.source === 'whatsapp')).toBe(false)
  })

  it('asks for clarification when Jev is unsure', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.4 })
    await post(textMessage('unsure', SELF, 'maybe look at that', true))
    expect(ctx.chatCalls()).toBe(0)
    expect(ctx.evolution.sent[0]?.text).toContain('not sure')
  })

  it('says it cannot decide when Jev is not configured', async () => {
    ctx.setJudged({ intent: 'unconfigured', confidence: 1 })
    await post(textMessage('no-jev', SELF, 'hello', true))
    expect(ctx.chatCalls()).toBe(0)
    expect(ctx.evolution.sent[0]?.text).toContain('cannot decide')
  })
})

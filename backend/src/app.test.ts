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
import { ownerPhoneFromInstances } from './whatsapp/qr'

class FakeEvolution implements EvolutionClient {
  sent: Array<{ number: string; text: string }> = []
  reactions: Array<{ remoteJid: string; messageId: string; fromMe: boolean; emoji: string }> = []
  created = 0
  deleted = 0
  failCreate = false
  failDownload = false
  ownerPhone: string | null = null
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

  async fetchOwnerPhone() {
    return this.ownerPhone
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
      if (input.unsure) {
        return 'Hi. What would you like to know? I can give you a brief on what is going on in the factory.'
      }
      if (input.snapshot) {
        const row = input.snapshot.inventory.find((item) => item.sku === 'PMPL-BS-40')
        return `Beyond Snack laminate on hand ${row?.onHand ?? 'unknown'}.`
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

  it('reports each customer’s materials and the overdrawn 80g line', async () => {
    const cookie = await login(ctx.app, 'anju@tierra.test')
    const response = await ctx.app.request('/api/inventory', { headers: { cookie } })
    const body = (await response.json()) as {
      items: Array<{ customerName: string; sku: string; kind: string; onHand: number }>
    }
    expect(body.items.find((item) => item.sku === 'PMPL-BS-40')).toMatchObject({
      customerName: 'Beyond Snack',
      kind: 'laminate',
      onHand: 860,
    })
    expect(body.items.find((item) => item.sku === 'FLV-TY-SALT')).toMatchObject({
      customerName: 'Guiltfree',
      kind: 'seasoning',
      onHand: 96,
    })
    expect(body.items.find((item) => item.sku === 'CTN-REL-CRT')).toMatchObject({
      customerName: 'Reliance Retail',
      kind: 'carton',
      onHand: 175,
    })
    expect(body.items.some((item) => item.sku === 'BAN-80G')).toBe(false)
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

  it('links a phone to an account and keeps that number unique', async () => {
    const office = await login(ctx.app, 'anju@tierra.test')
    const denied = await ctx.app.request('/api/relations', {
      method: 'PUT',
      headers: { cookie: office, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_anju', phoneNumber: '919812345678' }),
    })
    expect(denied.status).toBe(403)

    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const listed = await ctx.app.request('/api/relations', { headers: { cookie: admin } })
    const before = (await listed.json()) as { accounts: Array<{ id: string; phoneNumber: string | null }> }
    expect(before.accounts.find((account) => account.id === 'usr_anju')?.phoneNumber).toBeNull()

    const saved = await ctx.app.request('/api/relations', {
      method: 'PUT',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_anju', phoneNumber: '+91 98123 45678' }),
    })
    expect(saved.status).toBe(200)
    const body = (await saved.json()) as { accounts: Array<{ id: string; name: string; phoneNumber: string | null }> }
    expect(body.accounts.find((account) => account.id === 'usr_anju')).toMatchObject({
      name: 'Anju',
      phoneNumber: '919812345678',
    })

    const clash = await ctx.app.request('/api/relations', {
      method: 'PUT',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_joshy', phoneNumber: '9812345678' }),
    })
    expect(clash.status).toBe(409)

    const cleared = await ctx.app.request('/api/relations', {
      method: 'PUT',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'usr_anju', phoneNumber: '' }),
    })
    expect(cleared.status).toBe(200)
    const after = (await cleared.json()) as { accounts: Array<{ id: string; phoneNumber: string | null }> }
    expect(after.accounts.find((account) => account.id === 'usr_anju')?.phoneNumber).toBeNull()
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
    expect(ctx.evolution.sent[0]?.text.startsWith('> 🧞‍♂️ Tierra Bot:\n\n')).toBe(true)
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

  it('refuses the purchase order when finished-goods stock is short', async () => {
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
    expect(ctx.evolution.sent[0]?.text).toContain('Banana chips 80g is not available in sufficient quantity.')
    expect(ctx.evolution.sent[0]?.text).toContain('Added Banana chips 80g to procurement, assigned to Joshy.')
    expect(ctx.evolution.sent[0]?.text).toContain('An admin can reply YES to confirm PO PO-SHORT.')
    expect(ctx.evolution.sent[0]?.text).toContain('No order was created')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)
    expect(
      ctx.store.procurement.some(
        (order) => order.poNumber === 'PO-SHORT' && order.itemName === 'Banana chips 80g' && order.orderId === null,
      ),
    ).toBe(true)
  })

  it('creates the held order when an admin confirms', async () => {
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: '919812345678' })
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
    await post(pdfBody('m-hold'))
    const yes = await post(textMessage('m-yes', '919812345678@s.whatsapp.net', 'YES'))
    expect(yes.status).toBe(200)
    expect(ctx.evolution.sent.at(-1)?.text).toContain('Created order')
    expect(ctx.evolution.sent.at(-1)?.text).toContain('PO-SHORT')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(true)
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('refuses confirmation from an office account', async () => {
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: '919812345678' })
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
    await post(pdfBody('m-hold-office'))
    const yes = await post(textMessage('m-office-yes', '919812345678@s.whatsapp.net', 'YES'))
    expect(yes.status).toBe(200)
    expect(ctx.evolution.sent.at(-1)?.text).toContain('Only an admin can confirm PO PO-SHORT.')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)
  })

  it('tells WhatsApp when the buyer has no inventory', async () => {
    ctx.setExtracted({
      customerName: 'Acme Grocers',
      poNumber: '5901346472',
      poDate: '2026-06-05',
      lines: [
        {
          description: 'Fabsta Banana chips Salted 170g',
          quantity: 23220,
          unit: 'PC',
          buyerCode: null,
          price: 52.73,
        },
      ],
    })
    const response = await post(pdfBody('m-acme'))
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent[0]?.text).toContain('Acme Grocers')
    expect(ctx.evolution.sent[0]?.text).toContain('no laminate, seasoning, or carton inventory')
    expect(ctx.evolution.sent[0]?.text).toContain('No order was created')
    expect(ctx.store.orders.some((order) => order.poNumber === '5901346472')).toBe(false)
  })

  it('creates production and a banana procurement order from the Trent purchase order', async () => {
    await ctx.store.saveRelation({ userId: 'usr_joshy', phoneNumber: '919700000001' })
    for (const balance of ctx.store.balances) {
      if (balance.itemId === 'item_fab170') balance.onHand = 25000
      if (balance.itemId === 'item_fab500') balance.onHand = 3000
    }
    ctx.setExtracted({
      customerName: 'Trent Hypermarket Private Limited',
      poNumber: '5901346472',
      poDate: '2026-06-05',
      lines: [
        {
          description: 'Fabsta Banana chips Salted 170g',
          quantity: 23220,
          unit: 'PC',
          buyerCode: null,
          price: 52.73,
        },
        {
          description: 'Fabsta Banana Chips 500g',
          quantity: 2640,
          unit: 'PC',
          buyerCode: null,
          price: 151.84,
        },
      ],
    })
    const response = await post(pdfBody('m-trent'))
    expect(response.status).toBe(200)
    expect(ctx.evolution.sent[0]?.text).toContain('5,267.400 kg')
    expect(ctx.evolution.sent[0]?.text).toContain('21,413.853 kg')
    expect(ctx.evolution.sent[0]?.text).toContain('Joshy @919700000001')
    const entry = ctx.store.production.find((row) => row.poNumber === '5901346472')
    expect(entry?.finishedGoodsKg).toBe('5267.400')
    expect(entry?.bananaKg).toBe('21413.853')
    expect(ctx.store.procurement.find((row) => row.poNumber === '5901346472')?.assigneeName).toBe('Joshy')
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
    expect(ctx.evolution.sent[0]?.text).toBe('> 🧞‍♂️ Tierra Bot:\n\nTierra Bot here.')
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
    expect(ctx.evolution.sent[0]?.text).toBe(
      '> 🧞‍♂️ Tierra Bot:\n\nThe PDF could not be downloaded. No order was created.',
    )
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
    expect(ctx.evolution.sent[0]?.text).toContain('on hand 860')
    expect(ctx.lastJudge()?.chatKind).toBe('self')
    expect(ctx.lastChat()?.snapshot?.inventory.some((row) => row.sku === 'PMPL-BS-40')).toBe(true)
    expect(ctx.lastChat()?.snapshot?.emptyModules).toContain('My Day')

    const echo = await post(textMessage('out-1', SELF, 'Banana chips 80g available -60.', true))
    expect(echo.status).toBe(200)
    expect(ctx.judgeCalls()).toBe(1)
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.reactions).toHaveLength(1)
  })

  it('answers an operations question from the full dashboard', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.9 })
    await post(textMessage('cust-1', '919800000000@s.whatsapp.net', 'what is your stock'))
    expect(ctx.lastChat()?.snapshot?.inventory.some((row) => row.sku === 'PMPL-BS-40')).toBe(true)
    expect(ctx.lastChat()?.snapshot?.orders.length).toBeGreaterThan(0)
    expect(ctx.evolution.sent[0]?.text).toContain('on hand 860')
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

  it('knows which account sent a message and which account was mentioned', async () => {
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: '919812345678' })
    await ctx.store.saveRelation({ userId: 'usr_joshy', phoneNumber: '919700000001' })
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: '919900000000' })
    ctx.setJudged({ intent: 'conversation', confidence: 0.9 })
    const response = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: {
          id: 'g-who',
          remoteJid: GROUP,
          fromMe: false,
          participant: '919812345678@s.whatsapp.net',
        },
        message: {
          extendedTextMessage: {
            text: 'Tierra Bot, check with 919700000001',
            contextInfo: { mentionedJid: ['919900000000@s.whatsapp.net'] },
          },
        },
      },
    })
    expect(response.status).toBe(200)
    expect(ctx.lastJudge()?.speaker).toMatchObject({ name: 'Anju', role: 'office', phoneNumber: '919812345678' })
    expect(ctx.lastJudge()?.mentioned).toEqual([
      { name: 'Joshy', role: 'admin', phoneNumber: '919700000001' },
    ])
    expect(ctx.lastChat()?.speaker?.name).toBe('Anju')
    expect(ctx.lastChat()?.mentioned.map((person) => person.name)).toEqual(['Joshy'])
  })

  it('treats an unlinked personal chat as an unknown sender', async () => {
    ctx.setJudged({ intent: 'conversation', confidence: 0.9 })
    await post(textMessage('who-unknown', '919800000000@s.whatsapp.net', 'hello'))
    expect(ctx.lastChat()?.speaker).toBeNull()
    expect(ctx.lastChat()?.mentioned).toEqual([])
  })

  it('names the linked sender on a purchase-order reply', async () => {
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: '919812345678' })
    await post(pdfBody('m-who'))
    expect(ctx.evolution.sent[0]?.text).toContain('From Alex Thomas.')
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

  it('greets and offers a factory brief when Jev is unsure', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.4 })
    await post(textMessage('unsure', SELF, 'Hi', true))
    expect(ctx.chatCalls()).toBe(1)
    expect(ctx.lastChat()?.unsure).toBe(true)
    expect(ctx.lastChat()?.snapshot?.commandCentre.openOrders).toBe(3)
    expect(ctx.evolution.sent[0]?.text).toContain('brief on what is going on in the factory')
  })

  it('keeps the dashboard available when the owner agrees to a factory brief', async () => {
    ctx.setJudged({ intent: 'conversation', confidence: 0.4 })
    await post(textMessage('hi-1', SELF, 'Hello', true))
    ctx.setJudged({ intent: 'conversation', confidence: 0.9 })
    await post(textMessage('yes-1', SELF, 'Yes please', true))
    expect(ctx.lastChat()?.snapshot?.inventory.some((row) => row.sku === 'PMPL-BS-40')).toBe(true)
    expect(ctx.lastChat()?.history?.some((turn) => turn.text === 'Hello' && turn.speaker === 'owner')).toBe(
      true,
    )
    expect(ctx.lastChat()?.history?.some((turn) => turn.speaker === 'tierra')).toBe(true)
  })

  it('answers Message Yourself when the saved number still has a device suffix', async () => {
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: '91990000000012', qrBase64: null })
    await post(textMessage('self-suffix', SELF, 'Hey', true))
    expect(ctx.evolution.reactions[0]?.emoji).toBe('👀')
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.lastJudge()?.chatKind).toBe('self')
  })

  it('answers Message Yourself when WhatsApp sends a lid and the phone as an alias', async () => {
    const response = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: {
          id: 'self-lid',
          remoteJid: '123456789012345@lid',
          remoteJidAlt: SELF,
          fromMe: true,
        },
        message: { conversation: 'Hey' },
      },
    })
    expect(response.status).toBe(200)
    expect(ctx.lastJudge()?.chatKind).toBe('self')
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.sent[0]?.number).toBe('919900000000')
    expect(ctx.evolution.reactions[0]?.remoteJid).toBe('123456789012345@lid')
  })

  it('learns the connected number from Evolution and then answers Message Yourself', async () => {
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: null, qrBase64: null })
    ctx.evolution.ownerPhone = '919900000000'
    await post(textMessage('self-learn', SELF, 'Hey', true))
    expect((await ctx.store.getWhatsapp()).phoneNumber).toBe('919900000000')
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.lastJudge()?.chatKind).toBe('self')
  })

  it('stores the owner number without the device suffix when the connection opens', async () => {
    await ctx.store.saveWhatsapp({ status: 'qr_pending', phoneNumber: null, qrBase64: null })
    const connected = await post({
      event: 'connection.update',
      instance: 'tierra',
      data: { state: 'open', wuid: '919900000000:12@s.whatsapp.net' },
    })
    expect(connected.status).toBe(200)
    expect((await ctx.store.getWhatsapp()).phoneNumber).toBe('919900000000')
    await post(textMessage('after-connect', SELF, 'Hey', true))
    expect(ctx.evolution.sent).toHaveLength(1)
  })

  it('reads the tierra instance owner from an Evolution instance list', () => {
    expect(
      ownerPhoneFromInstances([
        { name: 'other', ownerJid: '911111111111@s.whatsapp.net' },
        { name: 'tierra', ownerJid: '919900000000:12@s.whatsapp.net' },
      ]),
    ).toBe('919900000000')
  })

  it('replies to every received personal message, including when the intent is ignore', async () => {
    ctx.setJudged({ intent: 'ignore', confidence: 0.95 })
    await post(textMessage('in-hey', '919812345678@s.whatsapp.net', 'Hey'))
    expect(ctx.lastJudge()?.chatKind).toBe('personal')
    expect(ctx.chatCalls()).toBe(1)
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.reactions[0]?.emoji).toBe('👀')
  })

  it('replies to a received personal message on an older WhatsApp jid', async () => {
    await post(textMessage('in-cus', '919812345678@c.us', 'Hi'))
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.lastJudge()?.chatKind).toBe('personal')
  })

  it('replies when a received personal message has no text', async () => {
    await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'in-image', remoteJid: '919812345678@s.whatsapp.net', fromMe: false },
        message: { imageMessage: { mimetype: 'image/jpeg' } },
      },
    })
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.evolution.sent[0]?.text).toBe('> 🧞‍♂️ Tierra Bot:\n\nTierra Bot is here.')
  })

  it('does not reply to a reaction on a personal chat', async () => {
    await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'in-react', remoteJid: '919812345678@s.whatsapp.net', fromMe: false },
        message: { reactionMessage: { text: '👍', key: { id: 'older' } } },
      },
    })
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.evolution.reactions).toHaveLength(0)
  })

  it('says it cannot decide when Jev is not configured', async () => {
    ctx.setJudged({ intent: 'unconfigured', confidence: 1 })
    await post(textMessage('no-jev', SELF, 'hello', true))
    expect(ctx.chatCalls()).toBe(0)
    expect(ctx.evolution.sent[0]?.text).toContain('cannot decide')
  })
})

describe('tierra agent desk', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  function pdfFile(name = 'po.pdf') {
    return new File([Buffer.from('%PDF-1.4 purchase order')], name, { type: 'application/pdf' })
  }

  async function postAgent(cookie: string, fields: { text?: string; file?: File }) {
    const form = new FormData()
    if (fields.text) form.set('text', fields.text)
    if (fields.file) form.set('file', fields.file)
    return ctx.app.request('/api/agent', {
      method: 'POST',
      headers: { cookie },
      body: form,
    })
  }

  const shortOrder: ExtractedPo = {
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
  }

  it('answers a dashboard question without calling Evolution', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 1 })
    const cookie = await login(ctx.app, 'alex.thomas@tierra.test')
    const response = await postAgent(cookie, { text: 'How is stock?' })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      message: { role: string; text: string }
      reply: { role: string; text: string }
    }
    expect(body.message).toMatchObject({ role: 'user', text: 'How is stock?' })
    expect(body.reply.role).toBe('tierra')
    expect(body.reply.text).toContain('Beyond Snack laminate')
    expect(body.reply.text).not.toContain('Tierra Bot:')
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.evolution.reactions).toHaveLength(0)
    expect(ctx.lastJudge()?.speaker).toMatchObject({ name: 'Alex Thomas', role: 'admin' })
    expect(ctx.lastJudge()?.chatKind).toBe('self')
    expect(ctx.lastChat()?.snapshot).toBeTruthy()

    const history = await ctx.app.request('/api/agent', { headers: { cookie } })
    const listed = (await history.json()) as { messages: Array<{ role: string; text: string }> }
    expect(listed.messages.map((message) => message.role)).toEqual(['user', 'tierra'])
    expect(listed.messages[1]?.text).toContain('Beyond Snack laminate')
  })

  it('creates an order tagged desk from a purchase-order PDF', async () => {
    const cookie = await login(ctx.app, 'joshy@tierra.test')
    const response = await postAgent(cookie, { file: pdfFile() })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      message: { filename: string | null; text: string }
      reply: { text: string }
    }
    expect(body.message.filename).toBe('po.pdf')
    expect(body.reply.text).toContain('Created order')
    expect(body.reply.text).toContain('PO-WA-1')
    expect(body.reply.text).not.toContain('@')
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.evolution.reactions).toHaveLength(0)
    expect(ctx.store.orders.find((order) => order.poNumber === 'PO-WA-1')?.source).toBe('desk')
  })

  it('refuses an office confirmation and lets an admin confirm on their own desk', async () => {
    ctx.setExtracted(shortOrder)
    const office = await login(ctx.app, 'anju@tierra.test')
    const held = await postAgent(office, { file: pdfFile('short.pdf') })
    const heldBody = (await held.json()) as { reply: { text: string } }
    expect(heldBody.reply.text).toContain('An admin can reply YES to confirm PO PO-SHORT.')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)

    const refused = await postAgent(office, { text: 'YES' })
    const refusedBody = (await refused.json()) as { reply: { text: string } }
    expect(refusedBody.reply.text).toContain('Only an admin can confirm PO PO-SHORT.')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)

    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    await postAgent(admin, { file: pdfFile('short-admin.pdf') })
    const confirmed = await postAgent(admin, { text: 'YES' })
    const confirmedBody = (await confirmed.json()) as { reply: { text: string } }
    expect(confirmedBody.reply.text).toContain('Created order')
    expect(confirmedBody.reply.text).toContain('PO-SHORT')
    expect(ctx.store.orders.find((order) => order.poNumber === 'PO-SHORT')?.source).toBe('desk')
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('rejects an empty send and a file that is not a PDF', async () => {
    expect((await ctx.app.request('/api/agent')).status).toBe(401)
    const cookie = await login(ctx.app, 'anju@tierra.test')
    const empty = await postAgent(cookie, {})
    expect(empty.status).toBe(400)
    const png = new File([Buffer.from('png')], 'note.png', { type: 'image/png' })
    const rejected = await postAgent(cookie, { text: 'see attached', file: png })
    expect(rejected.status).toBe(400)
    expect(ctx.store.orders.some((order) => order.source === 'desk')).toBe(false)
  })
})

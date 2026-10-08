import { beforeEach, describe, expect, it } from 'vitest'
import { hashPassword } from './auth/password'
import { createApp, loginLimiter, type AppDeps } from './app'
import { handleIncoming } from './agent/handle-message'
import { DEV_PASSWORD } from './db/seed-data'
import { MemoryStore } from './db/memory'
import { ExtractError } from './agent/extract'
import type { JudgeInput, JudgeResult } from './agent/judge'
import type { TaskExtraction } from './agent/extract-task'
import type { ChatInput } from './agent/reply'
import type { ExtractedPo } from './domain/intake'
import type { NewJob, TaskRecord } from './db/types'
import { inlineEnqueue } from './jobs/worker'
import type { EvolutionClient, MediaMessage, WhatsappGroup } from './whatsapp/evolution'
import { parseWebhook, type BotMode, type IncomingMessage } from './whatsapp/parse'
import { ownerPhoneFromInstances } from './whatsapp/qr'

class FakeEvolution implements EvolutionClient {
  sent: Array<{ number: string; text: string; mentions: string[] }> = []
  media: MediaMessage[] = []
  groups: WhatsappGroup[] = [{ id: '120363000@g.us', subject: 'Reliance – Tierra demo', size: 4 }]
  failGroups = false
  webhookSets = 0
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

  async sendText(number: string, text: string, mentionPhones: string[] = []) {
    this.sent.push({ number, text, mentions: mentionPhones })
    this.sentCount += 1
    return { messageId: `out-${this.sentCount}` }
  }

  async sendMedia(media: MediaMessage) {
    this.media.push(media)
    this.sentCount += 1
    return { messageId: `out-${this.sentCount}` }
  }

  async fetchAllGroups() {
    if (this.failGroups) throw new Error('down')
    return this.groups
  }

  async ensureWebhook() {
    this.webhookSets += 1
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

function incoming(body: unknown): IncomingMessage {
  const event = parseWebhook(body)
  if (event.type !== 'message') throw new Error('expected a message')
  return event.message
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

type SetupOptions = {
  enqueue?: (job: NewJob) => Promise<boolean>
  botMode?: BotMode
  secureCookie?: boolean
}

async function setup(options: SetupOptions = {}) {
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
  let taskDraft: TaskExtraction = {
    title: null,
    category: null,
    assigneeRole: null,
    assigneeUnknown: false,
  }
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
    extractTask: async () => taskDraft,
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
    enqueue: async () => true,
    botMode: options.botMode ?? 'personal',
    now: () => now,
    webhookSecret: secret,
    sessionTtlMs: 60_000,
    secureCookie: options.secureCookie,
  }
  deps.enqueue = options.enqueue ?? inlineEnqueue(deps)
  return {
    app: createApp(deps),
    deps,
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
    setTask(next: TaskExtraction) {
      taskDraft = next
    },
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
    expect(body.user.role).toBe('manager')
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
  it('stores a linked phone with its country code and refuses one it cannot complete', async () => {
    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const put = (userId: string, phoneNumber: string) =>
      ctx.app.request('/api/relations', {
        method: 'PUT',
        headers: { cookie: admin, 'content-type': 'application/json' },
        body: JSON.stringify({ userId, phoneNumber }),
      })
    const saved = await put('usr_anju', '98470 12345')
    const body = (await saved.json()) as { accounts: Array<{ id: string; phoneNumber: string | null }> }
    expect(body.accounts.find((account) => account.id === 'usr_anju')?.phoneNumber).toBe('919847012345')

    const short = await put('usr_joshy', '12345678')
    expect(short.status).toBe(400)
    expect(await short.json()).toEqual({ error: 'Enter the full number with country code, e.g. 91 98470 12345' })
    expect((await put('usr_joshy', '+91 98470 12345')).status).toBe(409)
    expect((await put('usr_joshy', '+44 98470 12345')).status).toBe(200)
  })
})

describe('whatsapp purchase orders', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: '919812345678' })
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
    expect(ctx.evolution.sent[0]?.text).toContain(
      'Added Banana chips 80g to procurement, assigned to the manager (Joshy).',
    )
    expect(ctx.evolution.sent[0]?.text).toContain('No order was created. Sent to the admin (Alex Thomas) to confirm.')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)
    expect(
      ctx.store.procurement.some(
        (order) => order.poNumber === 'PO-SHORT' && order.itemName === 'Banana chips 80g' && order.orderId === null,
      ),
    ).toBe(true)
  })

  it('creates the held order when an admin confirms', async () => {
    await ctx.store.deleteRelation('usr_anju')
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

  it('sends an office PO to the admin, and the office YES confirms nothing', async () => {
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: '919900000000' })
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
    const toAnju = ctx.evolution.sent.find((row) => row.number === '919812345678')
    expect(toAnju?.text).toContain('Sent to the admin (Alex Thomas) to confirm.')
    const toAlex = ctx.evolution.sent.find((row) => row.number === '919900000000')
    expect(toAlex?.text).toContain('po.pdf from Anju:')
    expect(toAlex?.text).toContain('An admin can reply YES to confirm PO PO-SHORT.')
    expect(ctx.store.pending[0]?.remoteJid).toBe('919900000000@s.whatsapp.net')

    await post(textMessage('m-office-yes', '919812345678@s.whatsapp.net', 'YES'))
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)

    await post(textMessage('m-admin-yes', '919900000000@s.whatsapp.net', 'YES'))
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(true)
    expect(ctx.evolution.sent.at(-1)).toMatchObject({ number: '919900000000' })
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
    const reply = ctx.evolution.sent.find((row) => row.number === '919812345678')
    expect(reply?.text).toContain('5,267.400 kg')
    expect(reply?.text).toContain('21,413.853 kg')
    expect(reply?.text).toContain('assigned to the manager (Joshy @919700000001)')
    expect(reply?.mentions).toEqual(['919700000001'])
    const notice = ctx.evolution.sent.find((row) => row.number === '919700000001')
    expect(notice?.text).toContain('Procure 21,413.853 kg raw banana for PO 5901346472')
    expect(ctx.store.tasks).toEqual([
      expect.objectContaining({
        kind: 'procurement',
        assigneeRole: 'manager',
        assigneeId: 'usr_joshy',
        subjectType: 'order',
        createdVia: 'system',
        createdBy: 'usr_anju',
      }),
    ])
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
      '> 🧞‍♂️ Tierra Bot:\n\nThe PDF could not be downloaded. No order was created. From Anju.',
    )
    expect(ctx.extractCalls()).toBe(0)
    expect(ctx.store.messages.some((row) => row.evolutionMessageId === 'm-download-fail')).toBe(true)
    expect(ctx.store.documents).toHaveLength(0)
  })
  it('handles a PDF message once, even when its turn runs again', async () => {
    await post(pdfBody('m-again'))
    expect(ctx.store.orders.filter((order) => order.poNumber === 'PO-WA-1')).toHaveLength(1)
    const sent = ctx.evolution.sent.length

    expect(await handleIncoming(ctx.deps, incoming(pdfBody('m-again')), 'personal')).toBeNull()
    expect(ctx.store.orders.filter((order) => order.poNumber === 'PO-WA-1')).toHaveLength(1)
    expect(ctx.store.documents).toHaveLength(1)
    expect(ctx.evolution.sent).toHaveLength(sent)
    expect(ctx.extractCalls()).toBe(1)
  })

  it('queues a PDF without its embedded bytes and downloads it when the turn runs', async () => {
    const queued: NewJob[] = []
    ctx = await setup({
      enqueue: async (job) => {
        queued.push(job)
        return true
      },
    })
    const body = pdfBody('m-bytes')
    Object.assign(body.data, { base64: 'JVBERi0xLjQ=' })
    Object.assign(body.data.message.documentMessage, { jpegThumbnail: '/9j/4AAQ', mediaKey: 'key==' })
    expect((await post(body)).status).toBe(200)
    expect(queued).toHaveLength(1)
    const payload = JSON.stringify(queued[0]?.payload)
    expect(payload).not.toContain('JVBER')
    expect(payload).not.toContain('jpegThumbnail')
    expect(payload).toContain('key==')
  })

  it('treats a queued message as a duplicate even when its registry row was lost', async () => {
    ctx = await setup({ enqueue: async (job) => Boolean(await ctx.store.enqueueJob(job)) })
    expect(await (await post(textMessage('m-lost', '919812345678@s.whatsapp.net', 'hello'))).json()).toEqual({ ok: true })
    await ctx.store.releaseMessage('m-lost')
    expect(await (await post(textMessage('m-lost', '919812345678@s.whatsapp.net', 'hello'))).json()).toEqual({
      duplicate: true,
    })
    expect(ctx.store.jobs.map((job) => job.idempotencyKey)).toEqual(['wa:m-lost'])
  })

  it('checks the webhook secret before reading the body', async () => {
    const huge = JSON.stringify({ event: 'messages.upsert', padding: 'x'.repeat(17 * 1024 * 1024) })
    const request = (header: string) =>
      ctx.app.request('/webhooks/evolution', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-webhook-secret': header },
        body: huge,
      })
    expect((await request('wrong')).status).toBe(401)
    expect((await request(secret)).status).toBe(413)
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

function reactionMessage(id: string, remoteJid: string, targetId: string, emoji: string, fromMe = false) {
  return {
    event: 'messages.upsert',
    instance: 'tierra',
    data: {
      key: { id, remoteJid, fromMe },
      message: { reactionMessage: { text: emoji, key: { id: targetId, remoteJid, fromMe: !fromMe } } },
    },
  }
}

function quotedReply(id: string, remoteJid: string, text: string, stanzaId: string, participant?: string) {
  return {
    event: 'messages.upsert',
    instance: 'tierra',
    data: {
      key: { id, remoteJid, fromMe: false, ...(participant ? { participant } : {}) },
      message: {
        extendedTextMessage: {
          text,
          contextInfo: { stanzaId, participant: '919900000000@s.whatsapp.net', quotedMessage: { conversation: 'earlier' } },
        },
      },
    },
  }
}

describe('tierra bot', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: '919900000000', qrBase64: null })
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: '919900000000' })
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

  it('answers a linked account’s operations question from the full dashboard', async () => {
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: '919800000000' })
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.9 })
    await post(textMessage('cust-1', '919800000000@s.whatsapp.net', 'what is your stock'))
    expect(ctx.lastChat()?.snapshot?.inventory.some((row) => row.sku === 'PMPL-BS-40')).toBe(true)
    expect(ctx.lastChat()?.snapshot?.orders.length).toBeGreaterThan(0)
    expect(ctx.evolution.sent[0]?.text).toContain('on hand 860')
  })

  it('never gives an unknown number the dashboard, even for a dashboard question', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.9 })
    await post(textMessage('cust-2', '919800000000@s.whatsapp.net', 'what is your stock'))
    expect(ctx.chatCalls()).toBe(1)
    expect(ctx.lastChat()?.speaker).toBeNull()
    expect(ctx.lastChat()?.snapshot).toBeNull()
    expect(ctx.evolution.sent[0]?.text).not.toContain('on hand')
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
    expect(ctx.lastChat()?.snapshot).toBeNull()
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
      { userId: 'usr_joshy', name: 'Joshy', role: 'manager', phoneNumber: '919700000001' },
    ])
    expect(ctx.lastChat()?.snapshot).toBeNull()
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

  it('acknowledges a group purchase order and sends the details to the admin', async () => {
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
    const inGroup = ctx.evolution.sent.filter((row) => row.number === GROUP)
    expect(inGroup.map((row) => row.text)).toEqual([
      '> 🧞‍♂️ Tierra Bot:\n\nReceived po.pdf. The Tierra team will confirm shortly.',
    ])
    const toAdmin = ctx.evolution.sent.find((row) => row.number === '919900000000')
    expect(toAdmin?.text).toContain('Created order')
    expect(toAdmin?.text).toContain('PO-WA-1')
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

  it('ignores a reaction to a message the bot never registered', async () => {
    const response = await post(reactionMessage('in-react', '919812345678@s.whatsapp.net', 'older', '👍'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ignored: true })
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.evolution.reactions).toHaveLength(0)
    expect(ctx.store.messages).toHaveLength(0)
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

  it('sends an office desk PO to the admin’s desk, where the admin confirms it', async () => {
    ctx.setExtracted(shortOrder)
    const office = await login(ctx.app, 'anju@tierra.test')
    const held = await postAgent(office, { file: pdfFile('short.pdf') })
    const heldBody = (await held.json()) as { reply: { text: string } }
    expect(heldBody.reply.text).toContain('Sent to the admin (Alex Thomas) to confirm.')
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-SHORT')).toBe(false)

    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const adminDesk = (await (await ctx.app.request('/api/agent', { headers: { cookie: admin } })).json()) as {
      messages: Array<{ text: string }>
    }
    expect(adminDesk.messages.at(-1)?.text).toContain('short.pdf from Anju:')
    expect(adminDesk.messages.at(-1)?.text).toContain('An admin can reply YES to confirm PO PO-SHORT.')

    const confirmed = await postAgent(admin, { text: 'YES' })
    const confirmedBody = (await confirmed.json()) as { reply: { text: string } }
    expect(confirmedBody.reply.text).toContain('Created order')
    expect(confirmedBody.reply.text).toContain('PO-SHORT')
    expect(ctx.store.orders.find((order) => order.poNumber === 'PO-SHORT')?.source).toBe('desk')
    expect(ctx.evolution.sent).toHaveLength(0)
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('renders the test PDF on the desk without sending it anywhere', async () => {
    const cookie = await login(ctx.app, 'anju@tierra.test')
    const response = await postAgent(cookie, { text: 'test pdf' })
    const body = (await response.json()) as { reply: { text: string } }
    expect(body.reply.text).toMatch(/^Test PDF rendered \(\d+ KB\)\.$/)
    expect(ctx.evolution.media).toHaveLength(0)
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

describe('task board', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  it('rejects a task without a category and lists a valid one', async () => {
    const cookie = await login(ctx.app, 'anju@tierra.test')
    const missing = await ctx.app.request('/api/tasks', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'File the invoices', assigneeId: null }),
    })
    expect(missing.status).toBe(400)
    expect(ctx.store.tasks).toHaveLength(0)

    const created = await ctx.app.request('/api/tasks', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'File the invoices', category: 'administration', assigneeId: 'usr_joshy' }),
    })
    expect(created.status).toBe(201)
    const listed = await ctx.app.request('/api/tasks', { headers: { cookie } })
    const body = (await listed.json()) as {
      tasks: Array<{ title: string; category: string; assigneeName: string | null; status: string }>
    }
    expect(body.tasks).toEqual([
      expect.objectContaining({
        title: 'File the invoices',
        category: 'administration',
        assigneeName: 'Joshy',
        status: 'todo',
      }),
    ])
  })

  it('adds an assigned task from chat', async () => {
    ctx.setJudged({ intent: 'create_task', confidence: 0.9 })
    ctx.setTask({
      title: 'Call the banana supplier',
      category: 'procurement',
      assigneeRole: 'office',
      assigneeUnknown: false,
    })
    const cookie = await login(ctx.app, 'joshy@tierra.test')
    const form = new FormData()
    form.set('text', 'Add a procurement task for Anju to call the banana supplier')
    const response = await ctx.app.request('/api/agent', { method: 'POST', headers: { cookie }, body: form })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { reply: { text: string } }
    expect(body.reply.text).toContain('Call the banana supplier')
    expect(body.reply.text).toContain('assigned to the office (Anju)')
    expect(ctx.store.tasks).toEqual([
      expect.objectContaining({
        title: 'Call the banana supplier',
        category: 'procurement',
        assigneeId: 'usr_anju',
        assigneeName: 'Anju',
        assigneeRole: 'office',
        createdBy: 'usr_joshy',
        createdVia: 'desk',
        status: 'todo',
      }),
    ])
    expect(ctx.chatCalls()).toBe(0)
  })

  it('does not add a task when the assignee is unknown', async () => {
    ctx.setJudged({ intent: 'create_task', confidence: 0.9 })
    ctx.setTask({
      title: 'Call the banana supplier',
      category: 'procurement',
      assigneeRole: null,
      assigneeUnknown: true,
    })
    const cookie = await login(ctx.app, 'joshy@tierra.test')
    const form = new FormData()
    form.set('text', 'Assign the supplier call to Ravi')
    const response = await ctx.app.request('/api/agent', { method: 'POST', headers: { cookie }, body: form })
    expect(response.status).toBe(200)
    const body = (await response.json()) as { reply: { text: string } }
    expect(body.reply.text).toContain('could not match')
    expect(ctx.store.tasks).toHaveLength(0)
  })
})

const ALEX_PHONE = '919900000000'
const JOSHY_PHONE = '919700000001'
const ANJU_PHONE = '919812345678'
const jid = (phone: string) => `${phone}@s.whatsapp.net`

describe('task notices on WhatsApp', () => {
  let ctx: Awaited<ReturnType<typeof setup>>
  let admin: string

  beforeEach(async () => {
    ctx = await setup()
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: ALEX_PHONE, qrBase64: null })
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: ALEX_PHONE })
    await ctx.store.saveRelation({ userId: 'usr_joshy', phoneNumber: JOSHY_PHONE })
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: ANJU_PHONE })
    admin = await login(ctx.app, 'alex.thomas@tierra.test')
  })

  async function post(body: unknown) {
    return ctx.app.request('/webhooks/evolution', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(body),
    })
  }

  async function createTask(body: Record<string, unknown>, cookie = admin): Promise<TaskRecord> {
    const response = await ctx.app.request('/api/tasks', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ category: 'operations', ...body }),
    })
    expect(response.status).toBe(201)
    return ((await response.json()) as { task: TaskRecord }).task
  }

  function noticeFor(taskId: string) {
    return ctx.store.messages.find((row) => row.purpose === 'task_notice' && row.subjectId === taskId)
  }

  it('routes a dashboard task to the manager and sends Joshy a registered notice', async () => {
    const task = await createTask({
      title: 'Check TRPMCN5 cartons',
      assigneeId: null,
      assigneeRole: 'manager',
      description: 'Count the cartons in bay 3.',
      dueAt: '2026-09-26T11:30:00.000Z',
    })
    expect(task).toMatchObject({
      assigneeId: 'usr_joshy',
      assigneeRole: 'manager',
      createdVia: 'dashboard',
      description: 'Count the cartons in bay 3.',
      dueAt: '2026-09-26T11:30:00.000Z',
    })
    expect(task.notifiedAt).not.toBeNull()
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.evolution.sent[0]?.number).toBe(JOSHY_PHONE)
    expect(ctx.evolution.sent[0]?.text).toBe(
      [
        '> 🧞‍♂️ Tierra Bot:',
        '',
        'New task from Alex Thomas · due 17:00',
        '*Check TRPMCN5 cartons*',
        'Count the cartons in bay 3.',
        'Reply *done* to this message or react 👍 when it is finished.',
      ].join('\n'),
    )
    expect(noticeFor(task.id)).toMatchObject({
      evolutionMessageId: 'out-1',
      remoteJid: jid(JOSHY_PHONE),
      fromMe: true,
      kind: 'text',
      purpose: 'task_notice',
      subjectType: 'task',
      status: 'sent',
    })
    expect(ctx.store.tasks[0]?.waMessageId).toBe('out-1')
  })

  it('does not send a notice for an unassigned task', async () => {
    await createTask({ title: 'Tidy the store room' })
    expect(ctx.evolution.sent).toHaveLength(0)
  })

  it('sends the notice again when the task moves to someone else', async () => {
    const task = await createTask({ title: 'Call XO Pack Zone about PO 43', assigneeRole: 'manager' })
    const moved = await ctx.app.request(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeId: null, assigneeRole: 'office' }),
    })
    expect(moved.status).toBe(200)
    const body = (await moved.json()) as { task: TaskRecord }
    expect(body.task).toMatchObject({ assigneeId: 'usr_anju', assigneeRole: 'office', waMessageId: 'out-2' })
    expect(ctx.evolution.sent.map((row) => row.number)).toEqual([JOSHY_PHONE, ANJU_PHONE])

    const same = await ctx.app.request(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ assigneeId: 'usr_anju', assigneeRole: null }),
    })
    expect(same.status).toBe(200)
    expect(ctx.evolution.sent).toHaveLength(2)
  })

  it('cancels a task from the dashboard', async () => {
    const task = await createTask({ title: 'Old chore', assigneeRole: 'office' })
    const cancelled = await ctx.app.request(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'cancelled' }),
    })
    expect(((await cancelled.json()) as { task: TaskRecord }).task.status).toBe('cancelled')
  })

  it('finishes the task when the holder reacts 👍 to the notice and tells the raiser', async () => {
    const task = await createTask({ title: 'Check TRPMCN5 cartons', assigneeRole: 'manager' })
    const notice = noticeFor(task.id)!
    const response = await post(reactionMessage('r-done', jid(JOSHY_PHONE), notice.evolutionMessageId, '👍🏽'))
    expect(response.status).toBe(200)
    expect((await ctx.store.getTask(task.id))?.status).toBe('done')
    expect((await ctx.store.getTask(task.id))?.completedAt).not.toBeNull()
    const toAlex = ctx.evolution.sent.find((row) => row.number === ALEX_PHONE)
    expect(toAlex?.text).toContain('Joshy finished “Check TRPMCN5 cartons”.')
    expect(ctx.evolution.sent.find((row) => row.number === JOSHY_PHONE && row.text.includes('Marked'))).toBeTruthy()
    expect(ctx.evolution.reactions).toHaveLength(0)
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.chatCalls()).toBe(0)
  })

  it('ignores a 👍 on the notice from someone who does not hold the task', async () => {
    const task = await createTask({ title: 'Check TRPMCN5 cartons', assigneeRole: 'manager' })
    const notice = noticeFor(task.id)!
    await post(reactionMessage('r-other', jid(ANJU_PHONE), notice.evolutionMessageId, '👍'))
    expect((await ctx.store.getTask(task.id))?.status).toBe('todo')
    expect(ctx.evolution.sent).toHaveLength(1)
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('finishes a task when the holder replies done to the notice', async () => {
    const first = await createTask({ title: 'Check cartons', assigneeRole: 'manager' })
    await createTask({ title: 'Call the transporter', assigneeRole: 'manager' })
    const notice = noticeFor(first.id)!
    await post(quotedReply('q-done', jid(JOSHY_PHONE), 'Done', notice.evolutionMessageId))
    expect((await ctx.store.getTask(first.id))?.status).toBe('done')
    expect(ctx.evolution.sent.at(-1)?.text).toContain('Marked "Check cartons" as done.')
    expect(ctx.evolution.sent.some((row) => row.number === ALEX_PHONE && row.text.includes('Joshy finished'))).toBe(true)
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('finishes the only open task on a bare done', async () => {
    const task = await createTask({ title: 'Check cartons', assigneeRole: 'manager' })
    await post(textMessage('bare-done', jid(JOSHY_PHONE), 'done.'))
    expect((await ctx.store.getTask(task.id))?.status).toBe('done')
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('asks which task when a bare done could mean two', async () => {
    const first = await createTask({ title: 'Check cartons', assigneeRole: 'manager' })
    const second = await createTask({ title: 'Call the transporter', assigneeRole: 'manager' })
    await post(textMessage('which-done', jid(JOSHY_PHONE), 'done'))
    expect((await ctx.store.getTask(first.id))?.status).toBe('todo')
    expect((await ctx.store.getTask(second.id))?.status).toBe('todo')
    expect(ctx.evolution.sent.at(-1)?.text).toContain('You have 2 open tasks')
    expect(ctx.judgeCalls()).toBe(0)
  })

  it('creates a manager task from a WhatsApp message and mentions the holder', async () => {
    ctx.setJudged({ intent: 'create_task', confidence: 0.9 })
    ctx.setTask({
      title: 'Call XO Pack Zone about PO 43',
      category: 'procurement',
      assigneeRole: 'manager',
      assigneeUnknown: false,
    })
    await post(textMessage('wa-task', jid(ALEX_PHONE), 'ask the manager to call XO Pack Zone about PO 43', true))
    expect(ctx.store.tasks).toEqual([
      expect.objectContaining({
        title: 'Call XO Pack Zone about PO 43',
        assigneeId: 'usr_joshy',
        assigneeRole: 'manager',
        createdBy: 'usr_alex',
        createdVia: 'whatsapp',
      }),
    ])
    const notice = ctx.evolution.sent.find((row) => row.number === JOSHY_PHONE)
    expect(notice?.text).toContain('*Call XO Pack Zone about PO 43*')
    const reply = ctx.evolution.sent.find((row) => row.number === ALEX_PHONE)
    expect(reply?.text).toContain(`assigned to the manager (Joshy @${JOSHY_PHONE})`)
    expect(reply?.mentions).toEqual([JOSHY_PHONE])
  })

  it('routes a role with no holder to the admin', async () => {
    await ctx.store.updateUserRole('usr_joshy', 'office')
    const task = await createTask({ title: 'Buy cartons', assigneeRole: 'manager' })
    expect(task).toMatchObject({ assigneeId: 'usr_alex', assigneeRole: 'manager' })
  })

  it('holds a short PO with a manager procurement task and sends the notice', async () => {
    ctx.setExtracted({
      customerName: 'Beyond Snack',
      poNumber: 'PO-SHORT',
      poDate: null,
      lines: [{ description: 'Banana chips 80g', quantity: 200, unit: 'pouch', buyerCode: 'BAN-80G', price: null }],
    })
    await post(pdfBody('short-task', jid(ANJU_PHONE)))
    expect(ctx.store.tasks).toEqual([
      expect.objectContaining({
        kind: 'procurement',
        category: 'procurement',
        assigneeRole: 'manager',
        assigneeId: 'usr_joshy',
        subjectType: 'pending_order',
        createdVia: 'system',
        createdBy: 'usr_anju',
        title: 'Procure Banana chips 80g for PO PO-SHORT',
      }),
    ])
    const notice = ctx.evolution.sent.find((row) => row.number === JOSHY_PHONE)
    expect(notice?.text).toContain('New task from Tierra Bot')
    expect(noticeFor(ctx.store.tasks[0]!.id)?.purpose).toBe('task_notice')
    expect(ctx.store.procurement.every((row) => row.assigneeId === 'usr_joshy')).toBe(true)
    const reply = ctx.evolution.sent.find((row) => row.number === ANJU_PHONE)
    expect(reply?.text).toContain(`assigned to the manager (Joshy @${JOSHY_PHONE})`)

    await post(pdfBody('short-task-again', jid(ANJU_PHONE)))
    expect(ctx.store.tasks).toHaveLength(2)
  })
  it('notices every change of holder, back to an earlier one too, and keeps a notice alive for two hours', async () => {
    const task = await createTask({ title: 'Count cartons', assigneeRole: 'manager' })
    const move = async (assigneeRole: string) => {
      await pause(2)
      const response = await ctx.app.request(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { cookie: admin, 'content-type': 'application/json' },
        body: JSON.stringify({ assigneeId: null, assigneeRole }),
      })
      expect(response.status).toBe(200)
    }
    await move('office')
    await move('manager')
    expect(ctx.evolution.sent.map((row) => row.number)).toEqual([JOSHY_PHONE, ANJU_PHONE, JOSHY_PHONE])
    const notices = ctx.store.jobs.filter((job) => job.kind === 'task.notify')
    expect(notices).toHaveLength(3)
    expect(notices.every((job) => job.maxAttempts === 30)).toBe(true)
    expect(notices[0]?.payload).toEqual({ taskId: task.id, assigneeId: 'usr_joshy' })
  })

  it('creates one task when a WhatsApp turn runs twice', async () => {
    ctx.setJudged({ intent: 'create_task', confidence: 0.9 })
    ctx.setTask({ title: 'Call XO Pack Zone', category: 'procurement', assigneeRole: 'manager', assigneeUnknown: false })
    const body = textMessage('wa-twice', jid(ALEX_PHONE), 'ask the manager to call XO Pack Zone', true)
    await post(body)
    await handleIncoming(ctx.deps, incoming(body), 'self')
    expect(ctx.store.tasks).toEqual([expect.objectContaining({ subjectType: 'wa_message', subjectId: 'wa-twice' })])
    expect(ctx.evolution.sent.filter((row) => row.number === JOSHY_PHONE)).toHaveLength(1)
  })

  it('sends the notices that never went out once WhatsApp reconnects', async () => {
    await ctx.store.deleteRelation('usr_anju')
    const task = await createTask({ title: 'File the GRN', assigneeRole: 'office' })
    await createTask({ title: 'Approve the rate', assigneeRole: 'office', kind: 'approval' })
    expect(ctx.evolution.sent).toHaveLength(0)
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: ANJU_PHONE })
    const open = { event: 'connection.update', instance: 'tierra', data: { state: 'open', wuid: jid(ALEX_PHONE) } }
    expect((await post(open)).status).toBe(200)
    expect(ctx.evolution.webhookSets).toBe(1)
    expect(ctx.evolution.sent.map((row) => row.number)).toEqual([ANJU_PHONE])
    expect((await ctx.store.getTask(task.id))?.waMessageId).toBe('out-1')
    await post(open)
    expect(ctx.evolution.sent).toHaveLength(1)
  })

  it('sends a notice whose sender died between reserving and sending, once WhatsApp reconnects', async () => {
    await ctx.store.deleteRelation('usr_anju')
    const task = await createTask({ title: 'Count cartons', assigneeRole: 'office' })
    const row = ctx.store.tasks.find((entry) => entry.id === task.id)!
    row.notifiedAt = new Date(now.getTime() - 60 * 60_000).toISOString()
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: ANJU_PHONE })
    await post({ event: 'connection.update', instance: 'tierra', data: { state: 'open', wuid: jid(ALEX_PHONE) } })
    expect(ctx.evolution.sent.map((entry) => entry.number)).toEqual([ANJU_PHONE])
    expect((await ctx.store.getTask(task.id))?.waMessageId).toBeTruthy()
  })

  const shortPo = (poNumber: string) => ({
    customerName: 'Beyond Snack',
    poNumber,
    poDate: null,
    lines: [{ description: 'Banana chips 80g', quantity: 200, unit: 'pouch', buyerCode: 'BAN-80G', price: null }],
  })

  it('cancels the procurement task when the admin declines a held PO, and keeps it on YES', async () => {
    ctx.setExtracted(shortPo('PO-NO'))
    await post(pdfBody('held-no', jid(ANJU_PHONE)))
    await post(textMessage('admin-no', jid(ALEX_PHONE), 'NO'))
    expect(ctx.store.tasks.find((task) => task.title.includes('PO-NO'))?.status).toBe('cancelled')
    expect(ctx.evolution.sent.at(-1)?.text).toContain('PO PO-NO was not confirmed.')

    ctx.setExtracted(shortPo('PO-YES'))
    await post(pdfBody('held-yes', jid(ANJU_PHONE)))
    await post(textMessage('admin-yes', jid(ALEX_PHONE), 'yes'))
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-YES')).toBe(true)
    expect(ctx.store.tasks.find((task) => task.title.includes('PO-YES'))?.status).toBe('todo')
  })

  it('asks which PO when two are waiting, and takes a PO number or a reply to the report', async () => {
    ctx.setExtracted(shortPo('PO-A'))
    await post(pdfBody('held-a', jid(ANJU_PHONE)))
    ctx.setExtracted(shortPo('PO-B'))
    await post(pdfBody('held-b', jid(ANJU_PHONE)))
    const reportFor = (poNumber: string) => {
      const pending = ctx.store.pending.find((row) => row.poNumber === poNumber)!
      return ctx.store.messages.find((row) => row.purpose === 'intake_report' && row.subjectId === pending.id)!
    }
    expect(reportFor('PO-A')).toMatchObject({ remoteJid: jid(ALEX_PHONE), subjectType: 'pending_order' })

    await post(textMessage('which', jid(ALEX_PHONE), 'YES'))
    expect(ctx.evolution.sent.at(-1)?.text).toContain('Which PO? Reply YES <PO number>, or reply to its message.')
    expect(ctx.store.orders.some((order) => ['PO-A', 'PO-B'].includes(order.poNumber))).toBe(false)

    await post(textMessage('yes-b', jid(ALEX_PHONE), 'yes po-b'))
    expect(ctx.store.orders.map((order) => order.poNumber)).toContain('PO-B')
    expect(ctx.store.orders.map((order) => order.poNumber)).not.toContain('PO-A')

    ctx.setExtracted(shortPo('PO-C'))
    await post(pdfBody('held-c', jid(ANJU_PHONE)))
    await post(quotedReply('no-a', jid(ALEX_PHONE), 'no', reportFor('PO-A').evolutionMessageId))
    expect(ctx.store.pending.find((row) => row.poNumber === 'PO-A')?.status).toBe('declined')
    expect(ctx.store.pending.find((row) => row.poNumber === 'PO-C')?.status).toBe('awaiting_admin')
  })

  it('lists who holds each role with the tasks', async () => {
    await ctx.store.updateUserRole('usr_anju', 'manager')
    const response = await ctx.app.request('/api/tasks', { headers: { cookie: admin } })
    const body = (await response.json()) as { holders: Record<string, { id: string; name: string } | null> }
    expect(body.holders).toEqual({
      admin: { id: 'usr_alex', name: 'Alex Thomas' },
      manager: { id: 'usr_anju', name: 'Anju' },
      office: null,
    })
  })
})

describe('whatsapp audience and leaks', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  async function start(botMode: BotMode = 'personal') {
    ctx = await setup({ botMode })
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: ALEX_PHONE, qrBase64: null })
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: ALEX_PHONE })
  }

  async function post(body: unknown) {
    return ctx.app.request('/webhooks/evolution', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-webhook-secret': secret },
      body: JSON.stringify(body),
    })
  }

  beforeEach(async () => {
    await start()
  })

  it('ignores the bot’s own 👀 reaction', async () => {
    await post(textMessage('in-1', jid(ANJU_PHONE), 'hello'))
    const response = await post(reactionMessage('eyes-1', jid(ANJU_PHONE), 'in-1', '👀', true))
    expect(await response.json()).toEqual({ ignored: true })
    expect(ctx.store.messages.some((row) => row.evolutionMessageId === 'eyes-1')).toBe(false)
  })

  it('ignores the echo of a message the bot sent', async () => {
    const response = await post(
      textMessage('echo-1', jid(ALEX_PHONE), '> 🧞‍♂️ Tierra Bot:\n\nSomething the bot said', true),
    )
    expect(await response.json()).toEqual({ ignored: true })
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.store.messages).toHaveLength(0)
  })

  it('ignores every message from its own number in dedicated mode', async () => {
    await start('dedicated')
    const response = await post(textMessage('self-1', jid(ALEX_PHONE), 'Hey', true))
    expect(await response.json()).toEqual({ ignored: true })
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.evolution.sent).toHaveLength(0)
  })

  it('answers a group message that quotes the bot without mentioning it', async () => {
    await post(textMessage('g-ask', GROUP, 'Tierra Bot, are you there?'))
    const botReply = ctx.store.messages.find((row) => row.fromMe && row.purpose === 'reply')!
    const response = await post(quotedReply('g-quote', GROUP, 'and the cartons?', botReply.evolutionMessageId, jid(ANJU_PHONE)))
    expect(await response.json()).toEqual({ ok: true })
    expect(ctx.judgeCalls()).toBe(2)
    expect(ctx.lastJudge()?.chatKind).toBe('group')
    expect(ctx.lastChat()?.snapshot).toBeNull()
    expect(ctx.store.messages.find((row) => row.evolutionMessageId === 'g-quote')).toMatchObject({
      quotedId: botReply.evolutionMessageId,
      senderJid: jid(ANJU_PHONE),
      kind: 'text',
      status: 'received',
    })
  })

  it('still ignores a group message that quotes someone else', async () => {
    const response = await post(quotedReply('g-other', GROUP, 'and the cartons?', 'someone-else'))
    expect(await response.json()).toEqual({ ignored: true })
  })

  it('never gives a group the dashboard, even from the admin', async () => {
    ctx.setJudged({ intent: 'dashboard_question', confidence: 0.95 })
    await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'g-admin', remoteJid: GROUP, fromMe: false, participant: jid(ALEX_PHONE) },
        message: { conversation: 'Tierra Bot, how much stock is left?' },
      },
    })
    expect(ctx.lastJudge()?.speaker?.name).toBe('Alex Thomas')
    expect(ctx.lastChat()?.snapshot).toBeNull()
  })

  it('keeps a held group PO between the bot and the admin, who confirms it with YES', async () => {
    await ctx.store.saveRelation({ userId: 'usr_alex', phoneNumber: ANJU_PHONE })
    ctx.setExtracted({
      customerName: 'Beyond Snack',
      poNumber: 'PO-GROUP',
      poDate: null,
      lines: [{ description: 'Banana chips 80g', quantity: 200, unit: 'pouch', buyerCode: 'BAN-80G', price: null }],
    })
    await post({
      event: 'MESSAGES_UPSERT',
      instance: 'tierra',
      data: {
        key: { id: 'g-po', remoteJid: GROUP, fromMe: false, participant: '919811111111@s.whatsapp.net' },
        message: {
          documentWithCaptionMessage: {
            message: {
              documentMessage: { mimetype: 'application/pdf', fileName: 'po-43.pdf', caption: 'Tierra Bot new PO' },
            },
          },
        },
      },
    })
    const inGroup = ctx.evolution.sent.filter((row) => row.number === GROUP)
    expect(inGroup.map((row) => row.text)).toEqual([
      '> 🧞‍♂️ Tierra Bot:\n\nReceived po-43.pdf. The Tierra team will confirm shortly.',
    ])
    const toAdmin = ctx.evolution.sent.find((row) => row.number === ANJU_PHONE)
    expect(toAdmin?.text).toContain('po-43.pdf from +919811111111 in group')
    expect(toAdmin?.text).toContain('Banana chips 80g is not available in sufficient quantity.')

    const inGroupYes = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'g-yes', remoteJid: GROUP, fromMe: false, participant: jid(ANJU_PHONE) },
        message: { extendedTextMessage: { text: 'YES', contextInfo: { mentionedJid: [jid(ALEX_PHONE)] } } },
      },
    })
    expect(inGroupYes.status).toBe(200)
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-GROUP')).toBe(false)

    await post(textMessage('dm-yes', jid(ANJU_PHONE), 'YES'))
    expect(ctx.store.orders.some((order) => order.poNumber === 'PO-GROUP')).toBe(true)
    expect(ctx.evolution.sent.at(-1)?.number).toBe(ANJU_PHONE)
    expect(ctx.evolution.sent.at(-1)?.text).toContain('Created order')
    expect(ctx.evolution.sent.filter((row) => row.number === GROUP)).toHaveLength(2)
    expect(ctx.evolution.sent.filter((row) => row.number === GROUP).some((row) => row.text.includes('PO-GROUP'))).toBe(
      false,
    )
  })

  it('only acknowledges a PDF from an unknown number and reports to the admin', async () => {
    await post(pdfBody('dm-po', '919811111111@s.whatsapp.net'))
    const reply = ctx.evolution.sent.find((row) => row.number === '919811111111')
    expect(reply?.text).toBe('> 🧞‍♂️ Tierra Bot:\n\nReceived po.pdf. The Tierra team will confirm shortly.')
    const toAdmin = ctx.evolution.sent.find((row) => row.number === ALEX_PHONE)
    expect(toAdmin?.text).toContain('Created order')
  })

  it('sends a test PDF as a registered document', async () => {
    const response = await post(textMessage('test-pdf', jid(ALEX_PHONE), 'test pdf', true))
    expect(response.status).toBe(200)
    expect(ctx.evolution.media).toHaveLength(1)
    const media = ctx.evolution.media[0]!
    expect(media).toMatchObject({ number: ALEX_PHONE, mediatype: 'document', mimetype: 'application/pdf' })
    expect(media.media.startsWith('JVBER')).toBe(true)
    expect(media.caption?.startsWith('> 🧞‍♂️ Tierra Bot:')).toBe(true)
    expect(ctx.store.messages.find((row) => row.purpose === 'test_pdf')).toMatchObject({
      evolutionMessageId: 'out-1',
      kind: 'document',
      fromMe: true,
    })
    expect(ctx.judgeCalls()).toBe(0)

    const echo = await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'out-1-echo', remoteJid: jid(ALEX_PHONE), fromMe: true },
        message: {
          documentMessage: { mimetype: 'application/pdf', fileName: 'tierra-test.pdf', caption: media.caption },
        },
      },
    })
    expect(await echo.json()).toEqual({ ignored: true })
    expect(ctx.extractCalls()).toBe(0)
  })

  it('does not render a test PDF for an unknown number', async () => {
    await post(textMessage('test-pdf-unknown', jid('919811111111'), 'test pdf'))
    expect(ctx.evolution.media).toHaveLength(0)
  })

  it('answers the webhook before the work runs, by queueing it', async () => {
    const queued: NewJob[] = []
    ctx = await setup({
      enqueue: async (job) => {
        queued.push(job)
        return true
      },
    })
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: ALEX_PHONE, qrBase64: null })
    const response = await post(textMessage('queued-1', jid(ANJU_PHONE), 'hello'))
    expect(response.status).toBe(200)
    expect(queued).toEqual([
      expect.objectContaining({ kind: 'wa.incoming', idempotencyKey: 'wa:queued-1', payload: expect.objectContaining({ audience: 'personal' }) }),
    ])
    expect(ctx.judgeCalls()).toBe(0)
    expect(ctx.evolution.reactions).toHaveLength(0)
    expect(ctx.store.messages.map((row) => row.evolutionMessageId)).toEqual(['queued-1'])
  })

  it('registers nothing when the queue is down, so Evolution retries', async () => {
    ctx = await setup({
      enqueue: async () => {
        throw new Error('queue down')
      },
    })
    await ctx.store.saveWhatsapp({ status: 'connected', phoneNumber: ALEX_PHONE, qrBase64: null })
    const response = await post(textMessage('queued-2', jid(ANJU_PHONE), 'hello'))
    expect(response.status).toBe(500)
    expect(ctx.store.messages).toHaveLength(0)
  })

  it('learns a LID from one message and fills it in on the next', async () => {
    await ctx.store.saveRelation({ userId: 'usr_anju', phoneNumber: ANJU_PHONE })
    await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: {
        key: { id: 'lid-1', remoteJid: '55500011122233@lid', remoteJidAlt: jid(ANJU_PHONE), fromMe: false },
        message: { conversation: 'hello' },
      },
    })
    await post({
      event: 'messages.upsert',
      instance: 'tierra',
      data: { key: { id: 'lid-2', remoteJid: '55500011122233@lid', fromMe: false }, message: { conversation: 'again' } },
    })
    expect(ctx.lastJudge()?.speaker?.name).toBe('Anju')
  })
})

describe('roles and sign-in', () => {
  let ctx: Awaited<ReturnType<typeof setup>>

  beforeEach(async () => {
    ctx = await setup()
  })

  async function setRole(cookie: string, userId: string, body: Record<string, unknown>) {
    return ctx.app.request(`/api/users/${userId}/role`, {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  function roles(accounts: Array<{ id: string; role: string }>) {
    return Object.fromEntries(accounts.map((account) => [account.id, account.role]))
  }

  it('lets only the admin change roles and keeps a single admin', async () => {
    const manager = await login(ctx.app, 'joshy@tierra.test')
    expect((await setRole(manager, 'usr_anju', { role: 'manager' })).status).toBe(403)

    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const second = await setRole(admin, 'usr_joshy', { role: 'admin' })
    expect(second.status).toBe(409)
    expect(((await second.json()) as { error: string }).error).toContain('Alex Thomas is the admin')

    const demoteSelf = await setRole(admin, 'usr_alex', { role: 'manager' })
    expect(demoteSelf.status).toBe(409)
    expect(((await demoteSelf.json()) as { error: string }).error).toContain('Make someone else admin first')

    const office = await setRole(admin, 'usr_anju', { role: 'manager' })
    expect(roles(((await office.json()) as { accounts: Array<{ id: string; role: string }> }).accounts)).toMatchObject({
      usr_anju: 'manager',
    })
    expect((await setRole(admin, 'usr_nobody', { role: 'office' })).status).toBe(404)
    expect((await setRole(admin, 'usr_anju', { role: 'owner' })).status).toBe(400)
  })

  it('transfers the admin role and the old admin loses admin rights', async () => {
    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const moved = await setRole(admin, 'usr_joshy', { role: 'admin', transfer: true })
    expect(moved.status).toBe(200)
    const body = (await moved.json()) as { accounts: Array<{ id: string; role: string }> }
    expect(roles(body.accounts)).toEqual({ usr_alex: 'manager', usr_joshy: 'admin', usr_anju: 'office' })
    expect((await setRole(admin, 'usr_anju', { role: 'manager' })).status).toBe(403)
  })

  it('lists WhatsApp groups for the admin only', async () => {
    const office = await login(ctx.app, 'anju@tierra.test')
    expect((await ctx.app.request('/api/whatsapp/groups', { headers: { cookie: office } })).status).toBe(403)
    const admin = await login(ctx.app, 'alex.thomas@tierra.test')
    const listed = await ctx.app.request('/api/whatsapp/groups', { headers: { cookie: admin } })
    expect(await listed.json()).toEqual({ groups: [{ id: GROUP, subject: 'Reliance – Tierra demo', size: 4 }] })
    ctx.evolution.failGroups = true
    expect((await ctx.app.request('/api/whatsapp/groups', { headers: { cookie: admin } })).status).toBe(502)
  })

  it('stops sign-in after 10 wrong passwords from the same address', async () => {
    const attempt = (password: string, ip = '203.0.113.7') =>
      ctx.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': ip },
        body: JSON.stringify({ email: 'anju@tierra.test', password }),
      })
    for (let i = 0; i < 10; i += 1) expect((await attempt('wrong')).status).toBe(401)
    const blocked = await attempt(DEV_PASSWORD)
    expect(blocked.status).toBe(429)
    expect(((await blocked.json()) as { error: string }).error).toContain('Too many sign-in attempts')
    expect((await attempt(DEV_PASSWORD, '198.51.100.2')).status).toBe(200)
  })

  it('marks the session cookie Secure when asked', async () => {
    const insecure = await ctx.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anju@tierra.test', password: DEV_PASSWORD }),
    })
    expect(insecure.headers.get('set-cookie')).not.toContain('Secure')

    const secure = await setup({ secureCookie: true })
    const response = await secure.app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'anju@tierra.test', password: DEV_PASSWORD }),
    })
    expect(response.headers.get('set-cookie')).toContain('; Secure')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
  })
  it('ignores a made-up X-Forwarded-For and limits one email across addresses', async () => {
    const attempt = (password: string, headers: Record<string, string>) =>
      ctx.app.request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ email: 'anju@tierra.test', password }),
      })
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('wrong', { 'x-forwarded-for': `198.51.100.${i}, 10.0.0.1` })).status).toBe(401)
    }
    expect((await attempt(DEV_PASSWORD, { 'x-forwarded-for': '198.51.100.99, 10.0.0.1' })).status).toBe(429)
    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('wrong', { 'x-real-ip': `203.0.113.${i}` })).status).toBe(401)
    }
    expect((await attempt(DEV_PASSWORD, { 'x-real-ip': '192.0.2.1' })).status).toBe(429)
  })

  it('forgets the oldest sign-in failures first once it holds 5,000', () => {
    const limiter = loginLimiter()
    for (let i = 0; i < 10; i += 1) limiter.fail('first', 0)
    expect(limiter.blocked('first', 10, 0)).toBe(true)
    for (let i = 0; i < 5_000; i += 1) limiter.fail(`key-${i}`, 0)
    expect(limiter.blocked('first', 10, 0)).toBe(false)
    expect(limiter.blocked('key-4999', 1, 0)).toBe(true)
  })
})

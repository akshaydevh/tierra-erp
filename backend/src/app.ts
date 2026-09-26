import { Hono } from 'hono'
import { z } from 'zod'
import { verifyPassword } from './auth/password'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  hashToken,
  newSessionToken,
  readCookie,
  sessionCookie,
} from './auth/cookie'
import type { ExtractedPo } from './domain/intake'
import { commandCentre, inventoryRows, orderDetail, orderList } from './domain/reads'
import type { Store } from './db/store'
import type { PublicUser } from './db/types'
import { acceptWebhook } from './whatsapp/accept'
import type { EvolutionClient } from './whatsapp/evolution'

export type AppDeps = {
  store: Store
  evolution: EvolutionClient
  extractPurchaseOrder: (pdf: Buffer) => Promise<ExtractedPo>
  now: () => Date
  webhookSecret: string
  sessionTtlMs: number
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

function publicConnection(connection: {
  status: string
  qrBase64: string | null
  phoneNumber: string | null
  instanceName: string
}) {
  return {
    instanceName: connection.instanceName,
    status: connection.status,
    qrBase64: connection.qrBase64,
    phoneNumber: connection.phoneNumber,
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  async function userFrom(cookieHeader: string | undefined): Promise<PublicUser | null> {
    const token = readCookie(cookieHeader, SESSION_COOKIE)
    if (!token) return null
    return deps.store.findUserByTokenHash(hashToken(token), deps.now())
  }

  app.get('/health', (c) => c.json({ ok: true }))

  app.post('/api/auth/login', async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Enter an email and password' }, 400)
    const user = await deps.store.findUserByEmail(parsed.data.email.toLowerCase())
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    const token = newSessionToken()
    await deps.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(deps.now().getTime() + deps.sessionTtlMs),
    })
    c.header('set-cookie', sessionCookie(token, Math.floor(deps.sessionTtlMs / 1000)))
    return c.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
  })

  app.post('/api/auth/logout', async (c) => {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    if (token) await deps.store.deleteSession(hashToken(token))
    c.header('set-cookie', clearSessionCookie())
    return c.json({ ok: true })
  })

  app.get('/api/auth/me', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ user })
  })

  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/')) return next()
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    await next()
  })

  app.get('/api/command-centre', async (c) => c.json(await commandCentre(deps.store)))
  app.get('/api/orders', async (c) => c.json({ orders: await orderList(deps.store) }))
  app.get('/api/orders/:id', async (c) => {
    const order = await orderDetail(deps.store, c.req.param('id'))
    if (!order) return c.json({ error: 'Order not found' }, 404)
    return c.json({ order })
  })
  app.get('/api/orders/:id/document', async (c) => {
    const doc = await deps.store.getOrderDocument(c.req.param('id'))
    if (!doc) return c.json({ error: 'Document not found' }, 404)
    const filename = doc.filename.replace(/"/g, '')
    c.header('content-type', doc.mimeType)
    c.header('content-disposition', `inline; filename="${filename}"`)
    return c.body(new Uint8Array(doc.content))
  })
  app.get('/api/inventory', async (c) => c.json({ items: await inventoryRows(deps.store) }))

  app.get('/api/whatsapp', async (c) => {
    return c.json({ connection: publicConnection(await deps.store.getWhatsapp()) })
  })

  app.post('/api/whatsapp/pair', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can connect WhatsApp' }, 403)
    try {
      const created = await deps.evolution.createInstance()
      const connection = await deps.store.saveWhatsapp({
        status: 'qr_pending',
        qrBase64: created.qrBase64,
        phoneNumber: null,
      })
      return c.json({ connection: publicConnection(connection) })
    } catch {
      return c.json({ error: 'WhatsApp gateway is unavailable' }, 502)
    }
  })

  app.post('/api/whatsapp/disconnect', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can disconnect WhatsApp' }, 403)
    try {
      await deps.evolution.deleteInstance()
    } catch {
      return c.json({ error: 'WhatsApp gateway is unavailable' }, 502)
    }
    const connection = await deps.store.saveWhatsapp({
      status: 'disconnected',
      qrBase64: null,
      phoneNumber: null,
    })
    return c.json({ connection: publicConnection(connection) })
  })

  app.post('/webhooks/evolution', async (c) => {
    const result = await acceptWebhook(
      deps,
      await c.req.text(),
      c.req.header('x-webhook-secret'),
    )
    return c.json(result.body, result.status as 200 | 400 | 401)
  })

  return app
}
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import { verifyPassword } from './auth/password'
import {
  SESSION_COOKIE,
  clearSessionCookie,
  hashToken,
  newSessionToken,
  readCookie,
  safeEqual,
  sessionCookie,
} from './auth/cookie'
import { PDF_BYTE_LIMIT, listDeskMessages, postDeskTurn } from './agent/desk'
import type { AgentDeps } from './agent/handle-message'
import { commandCentre, inventoryRows, orderDetail, orderList } from './domain/reads'
import { holderForRole } from './domain/routing'
import { ROLES, TASK_CATEGORIES, TASK_KINDS, type AccountLink, type PublicUser } from './db/types'
import { completeTask, createTaskAndNotify, reassignTask } from './tasks/service'
import { acceptWebhook } from './whatsapp/accept'
import { normalizePhone } from './whatsapp/people'

export type AppDeps = AgentDeps & {
  webhookSecret: string
  sessionTtlMs: number
  /** Adds Secure to the session cookie; on in production, off for local http. */
  secureCookie?: boolean
  /** Country code for a 10-digit mobile number typed without one. Defaults to 91. */
  defaultCountryCode?: string
}

const WEBHOOK_BODY_LIMIT = 16 * 1024 * 1024
const LOGIN_FAILURE_LIMIT = 10
const EMAIL_FAILURE_LIMIT = 20
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_KEYS_KEPT = 5_000
const PHONE_FORMAT = 'Enter the full number with country code, e.g. 91 98470 12345'

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

const relationSchema = z.object({
  userId: z.string().min(1),
  phoneNumber: z.string(),
})

const taskCategorySchema = z.enum(TASK_CATEGORIES)
const taskStatusSchema = z.enum(['todo', 'doing', 'done', 'cancelled'])
const roleSchema = z.enum(ROLES)

const createTaskSchema = z.object({
  title: z.string().trim().min(1),
  category: taskCategorySchema,
  kind: z.enum(TASK_KINDS).optional(),
  assigneeId: z.string().min(1).nullable().optional(),
  assigneeRole: roleSchema.nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  dueAt: z.string().datetime({ offset: true }).nullable().optional(),
})

const patchTaskSchema = z
  .object({
    status: taskStatusSchema.optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    assigneeRole: roleSchema.nullable().optional(),
  })
  .refine(
    (value) => value.status !== undefined || value.assigneeId !== undefined || value.assigneeRole !== undefined,
  )

const userRoleSchema = z.object({
  role: roleSchema,
  transfer: z.boolean().optional(),
})

/**
 * The address our proxy saw. X-Real-IP is set by the proxy; in X-Forwarded-For only the last entry
 * is added by the proxy, the earlier ones come from the client and can be made up.
 */
function clientIp(realIp: string | undefined, forwardedFor: string | undefined): string {
  return realIp?.trim() || forwardedFor?.split(',').at(-1)?.trim() || 'local'
}

/** Counts failed sign-ins per key in a fixed 15-minute window, remembering at most LOGIN_KEYS_KEPT keys. */
export function loginLimiter() {
  const failures = new Map<string, { count: number; resetAt: number }>()
  const live = (key: string, nowMs: number) => {
    const entry = failures.get(key)
    if (entry && entry.resetAt <= nowMs) failures.delete(key)
    return entry && entry.resetAt > nowMs ? entry : null
  }
  return {
    blocked: (key: string, limit: number, nowMs: number) => (live(key, nowMs)?.count ?? 0) >= limit,
    fail(key: string, nowMs: number) {
      const entry = live(key, nowMs)
      if (entry) {
        entry.count += 1
        return
      }
      for (const oldest of failures.keys()) {
        if (failures.size < LOGIN_KEYS_KEPT) break
        failures.delete(oldest)
      }
      failures.set(key, { count: 1, resetAt: nowMs + LOGIN_WINDOW_MS })
    },
    clear: (key: string) => failures.delete(key),
  }
}

/** Who each role resolves to, so the dashboard labels roles the way tasks are routed. */
function roleHolders(accounts: AccountLink[]) {
  return Object.fromEntries(
    ROLES.map((role) => {
      const holder = holderForRole(accounts, role)
      return [role, holder ? { id: holder.id, name: holder.name } : null]
    }),
  )
}

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

  async function accountExists(id: string | null | undefined): Promise<boolean> {
    if (!id) return true
    return (await deps.store.listAccountLinks()).some((account) => account.id === id)
  }

  async function userFrom(cookieHeader: string | undefined): Promise<PublicUser | null> {
    const token = readCookie(cookieHeader, SESSION_COOKIE)
    if (!token) return null
    return deps.store.findUserByTokenHash(hashToken(token), deps.now())
  }

  app.get('/health', (c) => c.json({ ok: true }))

  const logins = loginLimiter()

  app.post('/api/auth/login', async (c) => {
    const parsed = loginSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Enter an email and password' }, 400)
    const email = parsed.data.email.toLowerCase()
    const key = `${clientIp(c.req.header('x-real-ip'), c.req.header('x-forwarded-for'))}|${email}`
    const emailKey = `*|${email}`
    const nowMs = deps.now().getTime()
    if (logins.blocked(key, LOGIN_FAILURE_LIMIT, nowMs) || logins.blocked(emailKey, EMAIL_FAILURE_LIMIT, nowMs)) {
      return c.json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' }, 429)
    }
    const user = await deps.store.findUserByEmail(email)
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      logins.fail(key, nowMs)
      logins.fail(emailKey, nowMs)
      return c.json({ error: 'Invalid email or password' }, 401)
    }
    logins.clear(key)
    const token = newSessionToken()
    await deps.store.createSession({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(deps.now().getTime() + deps.sessionTtlMs),
    })
    c.header('set-cookie', sessionCookie(token, Math.floor(deps.sessionTtlMs / 1000), deps.secureCookie))
    return c.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
  })

  app.post('/api/auth/logout', async (c) => {
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    if (token) await deps.store.deleteSession(hashToken(token))
    c.header('set-cookie', clearSessionCookie(deps.secureCookie))
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
  app.get('/api/production', async (c) => c.json({ entries: await deps.store.listProductionEntries() }))
  app.get('/api/procurement', async (c) => c.json({ orders: await deps.store.listProcurementOrders() }))

  app.get('/api/tasks', async (c) => {
    const [tasks, accounts] = await Promise.all([deps.store.listTasks(), deps.store.listAccountLinks()])
    return c.json({ tasks, accounts, holders: roleHolders(accounts) })
  })

  app.post('/api/tasks', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Enter a title and choose a category' }, 400)
    if (!(await accountExists(parsed.data.assigneeId))) return c.json({ error: 'That account does not exist' }, 400)
    const { task } = await createTaskAndNotify(deps, {
      title: parsed.data.title,
      category: parsed.data.category,
      kind: parsed.data.kind,
      assigneeId: parsed.data.assigneeId ?? null,
      assigneeRole: parsed.data.assigneeRole ?? null,
      description: parsed.data.description || null,
      dueAt: parsed.data.dueAt ? new Date(parsed.data.dueAt) : null,
      createdVia: 'dashboard',
      createdBy: user.id,
    })
    return c.json({ task }, 201)
  })

  app.patch('/api/tasks/:id', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const parsed = patchTaskSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Choose a status or an assignee' }, 400)
    if (!(await accountExists(parsed.data.assigneeId))) return c.json({ error: 'That account does not exist' }, 400)
    const id = c.req.param('id')
    let task = await deps.store.getTask(id)
    if (!task) return c.json({ error: 'Task not found' }, 404)
    if (parsed.data.assigneeId !== undefined || parsed.data.assigneeRole !== undefined) {
      task = await reassignTask(deps, task, {
        assigneeId: parsed.data.assigneeId ?? null,
        assigneeRole: parsed.data.assigneeRole ?? null,
      })
      if (!task) return c.json({ error: 'Task not found' }, 404)
    }
    if (parsed.data.status === 'done') {
      await completeTask(deps, task, { userId: user.id, name: user.name })
    } else if (parsed.data.status) {
      await deps.store.updateTaskStatus(id, parsed.data.status)
    }
    return c.json({ task: await deps.store.getTask(id) })
  })

  app.get('/api/agent', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    return c.json({ messages: await listDeskMessages(deps, user.id) })
  })

  app.post('/api/agent', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const form = await c.req.parseBody().catch(() => null)
    if (!form || Array.isArray(form)) return c.json({ error: 'Write a message or attach a PDF' }, 400)
    const text = typeof form.text === 'string' ? form.text : ''
    const uploaded = form.file
    let pdf: { filename: string; content: Buffer } | null = null
    if (uploaded instanceof File) {
      if (uploaded.size === 0) {
        pdf = null
      } else if (uploaded.type !== 'application/pdf' && !uploaded.name.toLowerCase().endsWith('.pdf')) {
        return c.json({ error: 'Attach a PDF purchase order' }, 400)
      } else if (uploaded.size > PDF_BYTE_LIMIT) {
        return c.json({ error: 'That PDF is larger than 8MB' }, 400)
      } else {
        pdf = {
          filename: uploaded.name || 'purchase-order.pdf',
          content: Buffer.from(await uploaded.arrayBuffer()),
        }
      }
    } else if (uploaded != null && uploaded !== '') {
      return c.json({ error: 'Attach a PDF purchase order' }, 400)
    }
    const result = await postDeskTurn(deps, user, { text, pdf })
    if (!result.ok) return c.json({ error: result.error }, result.status)
    return c.json({ message: result.message, reply: result.reply })
  })

  app.get('/api/whatsapp', async (c) => {
    return c.json({ connection: publicConnection(await deps.store.getWhatsapp()) })
  })

  app.get('/api/relations', async (c) => {
    return c.json({ accounts: await deps.store.listAccountLinks() })
  })

  app.put('/api/relations', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can link a phone number' }, 403)
    const parsed = relationSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Choose an account and a phone number' }, 400)
    const accounts = await deps.store.listAccountLinks()
    const account = accounts.find((row) => row.id === parsed.data.userId)
    if (!account) return c.json({ error: 'That account does not exist' }, 404)
    if (!/\d/.test(parsed.data.phoneNumber)) {
      await deps.store.deleteRelation(account.id)
      return c.json({ accounts: await deps.store.listAccountLinks() })
    }
    const phone = normalizePhone(parsed.data.phoneNumber, deps.defaultCountryCode)
    if (!phone) return c.json({ error: PHONE_FORMAT }, 400)
    const taken = accounts.find((row) => row.id !== account.id && row.phoneNumber === phone)
    if (taken) return c.json({ error: `${taken.name} already uses that number` }, 409)
    await deps.store.saveRelation({ userId: account.id, phoneNumber: phone })
    return c.json({ accounts: await deps.store.listAccountLinks() })
  })

  app.put('/api/users/:id/role', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can change roles' }, 403)
    const parsed = userRoleSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Choose admin, manager, or office' }, 400)
    const accounts = await deps.store.listAccountLinks()
    const target = accounts.find((account) => account.id === c.req.param('id'))
    if (!target) return c.json({ error: 'That account does not exist' }, 404)
    const role = parsed.data.role
    if (target.role === role) return c.json({ accounts })
    if (target.role === 'admin') {
      return c.json({ error: 'Make someone else admin first. There must always be one admin.' }, 409)
    }
    if (role === 'admin') {
      const admin = accounts.find((account) => account.role === 'admin')
      if (admin && !parsed.data.transfer) {
        return c.json({ error: `${admin.name} is the admin. Transfer the admin role to make ${target.name} admin.` }, 409)
      }
      await deps.store.transferAdmin(target.id)
      return c.json({ accounts: await deps.store.listAccountLinks() })
    }
    const result = await deps.store.updateUserRole(target.id, role)
    if (result === 'not_found') return c.json({ error: 'That account does not exist' }, 404)
    if (result === 'admin_taken') return c.json({ error: 'There can only be one admin' }, 409)
    return c.json({ accounts: await deps.store.listAccountLinks() })
  })

  app.get('/api/whatsapp/groups', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can list WhatsApp groups' }, 403)
    try {
      return c.json({ groups: await deps.evolution.fetchAllGroups() })
    } catch {
      return c.json({ error: 'WhatsApp gateway is unavailable' }, 502)
    }
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

  const webhookLimit = bodyLimit({
    maxSize: WEBHOOK_BODY_LIMIT,
    onError: (c) => c.json({ error: 'Payload too large' }, 413),
  })

  app.post(
    '/webhooks/evolution',
    async (c, next) => {
      if (!safeEqual(c.req.header('x-webhook-secret'), deps.webhookSecret)) {
        return c.json({ error: 'Unauthorized' }, 401)
      }
      await next()
    },
    webhookLimit,
    async (c) => {
      const result = await acceptWebhook(deps, await c.req.text(), c.req.header('x-webhook-secret'))
      return c.json(result.body, result.status as 200 | 400 | 401)
    },
  )

  return app
}
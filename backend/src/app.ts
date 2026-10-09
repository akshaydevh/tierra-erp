import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { HTTPException } from 'hono/http-exception'
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
import { holderForRole } from './domain/routing'
import { PartyGroupConflictError } from './db/store'
import {
  CUSTOMER_PO_STATUSES,
  ROLES,
  SALES_ORDER_STATUSES,
  TASK_CATEGORIES,
  TASK_KINDS,
  type AccountLink,
  type PublicUser,
  type SalesOrderStatus,
} from './db/types'
import { dispatchDay, dispatchDays } from './queries/dispatch'
import { INVENTORY_TABS, inventory, inventoryKpis } from './queries/inventory'
import { searchItems, searchParties, withoutBalance } from './queries/masters'
import { importMeta, isNotImported } from './queries/meta'
import { cardInfo } from './queries/po'
import { PRODUCTION_STATUSES, productionKpis, productionOrder, productionOrders, withoutComponentValues, withoutOrderValues } from './queries/production'
import { PROCUREMENT_TABS, goodsReceipts, procurementKpis, purchaseOrders } from './queries/purchasing'
import { ORDER_STATES, customerPos, orderBook, orderKpis, recentSalesOrders, salesOrder, salesSummary } from './queries/sales'
import { isIsoDay, pageRequest } from './sap/db'
import { completeTask, createTaskAndNotify, reassignTask } from './tasks/service'
import { myDay } from './tasks/my-day'
import { normaliseUnit } from './domain/receipts'
import { approvalHistory, fileBySha, filesForDocuments, parseDocKey, type DocKey, type RecordAccess } from './queries/documents'
import { customerGroupFor, salesOrderView } from './workflows/po-to-so'
import { cancelSalesOrder, pendingApprovals } from './workflows/so-approval'
import { PoReviewError, confirmPoReview, reviewPo } from './workflows/po-intake'
import { syncWithSap } from './workflows/sap-sync'
import { notifyAdmin } from './agent/intake'
import { recordReceipt } from './workflows/receipts'
import { approvalCards, approvalViews, decideFromDesk, requestLabels, salesOrderSummary } from './workflows/desk-views'
import { acceptWebhook } from './whatsapp/accept'
import {
  DAILY_INPUT_ROLES,
  FINANCE_ROLES,
  MANPOWER_KEYS,
  PAYROLL_ROLES,
  OUTWARDS_BASES,
  type Role,
} from './db/types'
import {
  SETTING_BASIS,
  buildDailyReport,
  defaultReportDate,
  lineLabel,
  loadLabelBook,
  reportSettings,
} from './domain/daily-report'
import {
  ageingGroups,
  bankAccounts,
  bankBook,
  cardBalances,
  financeKpis,
  paymentRequests,
  payments,
  paymentsByPurpose,
} from './queries/finance'
import { generateDailyReport, sendReportTo } from './workflows/daily-report'
import { NO_LABOUR, costingKpis, costingMonths, materialMix, monthOf, productionCost, productionCosts, skuMargins, stockValuation, wipVariance } from './queries/costing'
import { attendanceMonth, headcount, hrMeta, hrOrNull, leaveSummary, payrollSummary, peelingMonth, reconciliation } from './queries/payroll'
import { addMonths, lastDayOf } from './domain/months'
import { dmAddress } from './agent/send'
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
    /** Approval tasks: the admin's decision from the dashboard. Reject is desk-only. */
    action: z.enum(['approve', 'send_back', 'reject', 'stop']).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .refine(
    (value) =>
      value.status !== undefined || value.assigneeId !== undefined || value.assigneeRole !== undefined || value.action !== undefined,
  )

const adjustmentSchema = z.object({
  itemCode: z.string().trim().min(2).max(40),
  qty: z.number().positive().max(10_000_000),
  unit: z.string().trim().max(10).nullable().optional(),
})

const noteSchema = z.object({ note: z.string().trim().max(1000).optional() }).nullable()

const poReviewSchema = z.object({
  cardCode: z.string().trim().max(40).nullable().optional(),
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        itemCode: z.string().trim().min(2).max(40),
        pcsPerUom: z.number().positive().max(100_000).nullable().optional(),
      }),
    )
    .max(60)
    .optional(),
})

const MAX_DISPATCH_DAYS = 366

export const PAYMENT_TABS = ['bank', 'receipts', 'purposes', 'receivables', 'payables', 'approvals'] as const
export const COSTING_TABS = ['skus', 'customers', 'orders', 'mix', 'valuation'] as const
const COSTING_SPANS = ['1', '3', '6', '12'] as const

const count = z.number().int().min(0).max(10_000)
const dailyInputsSchema = z
  .object({
    productionRun: z.boolean().nullable().optional(),
    packingRun: z.boolean().nullable().optional(),
    cartoningRun: z.boolean().nullable().optional(),
    manpower: z
      .object(Object.fromEntries(MANPOWER_KEYS.map((key) => [key, count])) as Record<(typeof MANPOWER_KEYS)[number], typeof count>)
      .nullable()
      .optional(),
    bananaKgEstimate: z.number().min(0).max(1_000_000).nullable().optional(),
    cassavaKgEstimate: z.number().min(0).max(1_000_000).nullable().optional(),
    inwardRemarks: z.record(z.string().max(40), z.string().max(300)).optional(),
    notes: z.string().max(1000).nullable().optional(),
  })
  .strict()

const reportSettingsSchema = z.object({ outwardsBasis: z.enum(OUTWARDS_BASES) })

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function docEntryParam(value: string): number | null {
  const entry = Number(value)
  return /^\d+$/.test(value) && Number.isSafeInteger(entry) && entry > 0 ? entry : null
}

/**
 * An inline Content-Disposition for a stored file name: a plain ASCII name for old clients and the
 * UTF-8 name for the rest, so quotes, line breaks or non-Latin letters cannot break the header.
 */
function inlineDisposition(filename: string): string {
  const name = filename.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'document.pdf'
  const ascii = name.replace(/[^\w .()-]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return `inline; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** File types the browser may render inline; anything else from SAP (xlsx, docx ...) is a download. */
const SERVED_INLINE = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif'])

function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
}

const waGroupSchema = z
  .object({ partyGroupId: z.string().min(1).nullable().optional(), sendSo: z.boolean().optional() })
  .refine((value) => value.partyGroupId !== undefined || value.sendSo !== undefined)

const partyGroupSchema = z.object({
  name: z.string().trim().min(1).max(120),
  alias: z.string().trim().max(60).nullable().optional(),
  members: z
    .array(z.object({ kind: z.enum(['pan', 'card_code']), value: z.string().trim().min(1).max(20) }))
    .max(200),
})

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

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse()
    if (isNotImported(error)) return c.json({ error: 'SAP data not imported yet' }, 503)
    console.error(error)
    return c.json({ error: 'Something went wrong' }, 500)
  })

  const sap = deps.sapSql

  app.get('/api/meta', async (c) => c.json(await importMeta(sap)))

  app.get('/api/command-centre', async (c) => {
    const [meta, connection] = await Promise.all([importMeta(sap), deps.store.getWhatsapp()])
    const whatsapp = { status: connection.status, phoneNumber: connection.phoneNumber }
    if (!meta.dataAsOf) {
      return c.json({
        dataAsOf: null,
        kpis: {
          openSalesOrders: 0,
          staleOpenSalesOrders: 0,
          salesMtdValue: 0,
          salesMtdCount: 0,
          invoicesLastDay: 0,
          fgShortItems: 0,
        },
        whatsapp,
        recentSalesOrders: [],
      })
    }
    const [sales, stock, recent] = await Promise.all([
      salesSummary(sap, meta.dataAsOf),
      inventoryKpis(sap),
      recentSalesOrders(sap, 5),
    ])
    return c.json({
      dataAsOf: meta.dataAsOf,
      kpis: { ...sales, fgShortItems: stock.fgShort },
      whatsapp,
      recentSalesOrders: recent,
    })
  })

  app.get('/api/inventory', async (c) => {
    const tab = oneOf(c.req.query('tab'), INVENTORY_TABS, 'fg')
    return c.json(
      await inventory(sap, { tab, role: c.req.query('role') || null, q: c.req.query('q'), page: c.req.query('page') }),
    )
  })

  app.get('/api/orders', async (c) => {
    const tab = c.req.query('tab') === 'customer-pos' ? 'customer-pos' : 'book'
    const filter = {
      state: oneOf(c.req.query('state'), ORDER_STATES, 'all'),
      q: c.req.query('q'),
      po: c.req.query('po') || null,
      party: c.req.query('party') || null,
      page: c.req.query('page'),
    }
    const asOf = (await importMeta(sap)).dataAsOf
    const [kpis, rows] = await Promise.all([
      orderKpis(sap, asOf),
      tab === 'book' ? orderBook(sap, filter) : customerPos(sap, filter),
    ])
    return c.json({ kpis, ...rows })
  })

  app.get('/api/orders/so/:docEntry', async (c) => {
    const docEntry = docEntryParam(c.req.param('docEntry'))
    const order = docEntry ? await salesOrder(sap, docEntry) : null
    if (!order) return c.json({ error: 'Sales order not found' }, 404)
    return c.json(order)
  })

  app.get('/api/dispatch', async (c) => {
    const asked = c.req.query('date')
    if (asked && !isIsoDay(asked)) return c.json({ error: 'Use a date like 2026-07-23' }, 400)
    const date = asked || (await importMeta(sap)).dataAsOf
    if (!date) return c.json({ error: 'SAP data not imported yet' }, 503)
    return c.json(await dispatchDay(sap, date, 'all'))
  })

  app.get('/api/dispatch/days', async (c) => {
    const from = c.req.query('from')
    const to = c.req.query('to')
    if (!isIsoDay(from) || !isIsoDay(to) || daysBetween(from, to) < 0 || daysBetween(from, to) > MAX_DISPATCH_DAYS) {
      return c.json({ error: 'Choose a from and to date at most a year apart' }, 400)
    }
    return c.json({ from, to, days: await dispatchDays(sap, from, to) })
  })

  app.get('/api/production', async (c) => {
    const status = c.req.query('status')
    const filter = {
      status: PRODUCTION_STATUSES.find((value) => value === status) ?? null,
      q: c.req.query('q'),
      page: c.req.query('page'),
    }
    const asOf = (await importMeta(sap)).dataAsOf
    const [kpis, rows, access] = await Promise.all([productionKpis(sap, asOf), productionOrders(sap, filter), recordAccessOf(c)])
    // ₹ values are costing: the manager and the admin only; the office keeps the quantities
    return c.json({ kpis, ...rows, rows: access === 'finance' ? rows.rows : rows.rows.map(withoutOrderValues) })
  })

  app.get('/api/production/:docEntry', async (c) => {
    const docEntry = docEntryParam(c.req.param('docEntry'))
    const order = docEntry ? await productionOrder(sap, docEntry) : null
    if (!order) return c.json({ error: 'Production order not found' }, 404)
    if ((await recordAccessOf(c)) === 'finance') return c.json(order)
    return c.json({ order: withoutOrderValues(order.order), components: order.components.map(withoutComponentValues) })
  })

  app.get('/api/procurement', async (c) => {
    const asked = c.req.query('tab')
    if (asked === 'requests' || asked === 'adjustments') {
      const [kpis, requests, adjustments] = await Promise.all([
        procurementKpis(sap, (await importMeta(sap)).dataAsOf).catch((error: unknown) => {
          if (isNotImported(error)) return { openPos: 0, openPoValue: 0, grnsMtd: 0, freeIssueGrnsMtd: 0 }
          throw error
        }),
        asked === 'requests' ? deps.store.listProcurementRequests({ limit: 300 }) : Promise.resolve([]),
        asked === 'adjustments' ? deps.store.listStockAdjustments({ limit: 300 }) : Promise.resolve([]),
      ])
      if (asked === 'adjustments') return c.json({ kpis, rows: adjustments, total: adjustments.length, page: 1, pageSize: adjustments.length })
      const labels = await requestLabels(deps, requests)
      const rows = requests.map((row) => ({ ...row, ...labels(row) }))
      return c.json({ kpis, rows, total: rows.length, page: 1, pageSize: rows.length })
    }
    const tab = oneOf(asked, PROCUREMENT_TABS, 'pos')
    const filter = { q: c.req.query('q'), page: c.req.query('page') }
    const asOf = (await importMeta(sap)).dataAsOf
    const [kpis, rows] = await Promise.all([
      procurementKpis(sap, asOf),
      tab === 'pos' ? purchaseOrders(sap, filter) : goodsReceipts(sap, filter),
    ])
    return c.json({ kpis, ...rows })
  })

  app.get('/api/items', async (c) => c.json({ rows: await searchItems(sap, c.req.query('q')) }))
  app.get('/api/parties', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    const rows = await searchParties(sap, c.req.query('q'))
    // a party's balance is finance: the manager and the admin only
    return c.json({ rows: user && FINANCE_ROLES.includes(user.role) ? rows : rows.map(withoutBalance) })
  })

  app.get('/api/documents/:id', async (c) => {
    const doc = await deps.store.getDocument(c.req.param('id'))
    if (!doc) return c.json({ error: 'Document not found' }, 404)
    if (doc.kind === 'report') {
      // a stored daily report carries bank balances: finance, the manager and the admin only
      const user = await userFrom(c.req.header('cookie'))
      if (!user || !FINANCE_ROLES.includes(user.role)) return c.json({ error: 'This is for the manager and the admin' }, 403)
    }
    // Only PDFs are stored; the sender's MIME type is not trusted for an inline response.
    c.header('content-type', 'application/pdf')
    c.header('content-disposition', inlineDisposition(doc.filename))
    c.header('x-content-type-options', 'nosniff')
    return c.body(new Uint8Array(doc.content))
  })

  /** Files and approvals of payments, journal entries and business partners: the manager and the admin only. */
  async function recordAccessOf(c: Context): Promise<RecordAccess> {
    const user = await userFrom(c.req.header('cookie'))
    return user && FINANCE_ROLES.includes(user.role) ? 'finance' : 'operations'
  }

  // SAP attachment files. Every dashboard account is Tierra staff (office and up). The office sees the files of
  // operations documents; the files of payments, journal entries and business partners (KYC) are for the manager and
  // the admin, and a file linked only to those is not found for the office. A customer never signs in here
  // (customers get files only through their WhatsApp group).
  app.get('/api/files/:sha', async (c) => {
    const sha = c.req.param('sha').toLowerCase()
    const [file] = await fileBySha(sap, sha, await recordAccessOf(c))
    if (!file) return c.json({ error: 'File not found' }, 404)
    if (!deps.files) return c.json({ error: 'File storage is not set up on this server' }, 503)
    const mime = SERVED_INLINE.has(file.mime) ? file.mime : 'application/octet-stream'
    const missing = () => c.json({ error: 'The file is on record but missing from storage' }, 404)
    if (deps.files.presignedUrl) {
      if (!(await deps.files.has(file.storageKey))) return missing()
      return c.redirect(await deps.files.presignedUrl(file.storageKey, { fileName: file.fileName, mime }), 302)
    }
    const bytes = await deps.files.get(file.storageKey)
    if (!bytes) return missing()
    c.header('content-type', mime)
    c.header(
      'content-disposition',
      SERVED_INLINE.has(file.mime) ? inlineDisposition(file.fileName) : inlineDisposition(file.fileName).replace(/^inline/, 'attachment'),
    )
    c.header('x-content-type-options', 'nosniff')
    c.header('cache-control', 'private, max-age=3600')
    return c.body(new Uint8Array(bytes))
  })

  // Files on record for some SAP documents: ?docs=13:5120,20:881 (object type:doc entry), at most 200.
  app.get('/api/document-files', async (c) => {
    const keys = (c.req.query('docs') ?? '')
      .split(',')
      .map((value) => parseDocKey(value.trim()))
      .filter((key): key is DocKey => key !== null)
      .slice(0, 200)
    const found = await filesForDocuments(sap, 'all', keys, await recordAccessOf(c))
    const files: Record<string, unknown[]> = {}
    for (const [key, rows] of found) {
      files[key] = rows.map((row) => ({
        sha256: row.sha256,
        role: row.role,
        fileName: row.fileName,
        mime: row.mime,
        sizeBytes: row.sizeBytes,
        href: `/api/files/${row.sha256}`,
      }))
    }
    return c.json({ files })
  })


  // ------------------------------------------------------------------------------------------ P6: payments, reports

  async function userWithRole(
    c: Context,
    roles: readonly Role[],
    refusal = 'This is for the manager and the admin',
  ): Promise<PublicUser | Response> {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (!roles.includes(user.role)) return c.json({ error: refusal }, 403)
    return user
  }

  /** The Payments page (manager and admin): KPIs and one tab of data. */
  app.get('/api/payments', async (c) => {
    const user = await userWithRole(c, FINANCE_ROLES)
    if (user instanceof Response) return user
    const meta = await importMeta(sap)
    if (!meta.dataAsOf) return c.json({ error: 'SAP data not imported yet' }, 503)
    const asOf = meta.dataAsOf
    const tab = oneOf(c.req.query('tab'), PAYMENT_TABS, 'bank')
    const from = isIsoDay(c.req.query('from')) ? c.req.query('from')! : `${asOf.slice(0, 7)}-01`
    const to = isIsoDay(c.req.query('to')) ? c.req.query('to')! : asOf
    if (daysBetween(from, to) < 0 || daysBetween(from, to) > 3 * MAX_DISPATCH_DAYS) {
      return c.json({ error: 'Choose a from date before the to date, at most three years apart' }, 400)
    }
    const [kpis, accounts] = await Promise.all([financeKpis(sap, asOf), bankAccounts(sap)])
    const base = { asOf, tab, from, to, kpis, accounts }
    const page = c.req.query('page')
    if (tab === 'bank') {
      const asked = c.req.query('bank')
      const account = accounts.find((row) => row.glCode === asked) ?? accounts.find((row) => row.houseBank) ?? accounts[0]
      if (!account) return c.json({ ...base, bank: null })
      const [book, labels] = await Promise.all([bankBook(sap, { glCode: account.glCode, from, to, page }), loadLabelBook(deps.store)])
      return c.json({ ...base, bank: { account, ...book, rows: book.rows.map((row) => ({ ...row, label: lineLabel(row, labels) })) } })
    }
    if (tab === 'receipts') {
      return c.json({ ...base, list: await payments(sap, { direction: 'in', from, to, q: c.req.query('q'), page }) })
    }
    if (tab === 'purposes') {
      const purpose = c.req.query('purpose') || null
      const [groups, list] = await Promise.all([
        paymentsByPurpose(sap, from, to),
        purpose
          ? payments(sap, {
              direction: 'out',
              from,
              to,
              page,
              ...(purpose === 'supplier' || purpose === 'customer'
                ? { kind: purpose, transfer: false }
                : purpose === 'transfer'
                  ? { transfer: true }
                  : { purposeGl: purpose, transfer: false }),
            })
          : Promise.resolve(null),
      ])
      return c.json({ ...base, purposes: groups, purpose, list })
    }
    if (tab === 'receivables' || tab === 'payables') {
      const side = tab === 'receivables' ? 'receivable' : 'payable'
      const group = c.req.query('group') || null
      const [groups, cards, top] = await Promise.all([
        ageingGroups(sap, { side }),
        group ? cardBalances(sap, { side, groupKey: group, limit: 100 }) : Promise.resolve(null),
        cardBalances(sap, { side, limit: 5 }),
      ])
      return c.json({ ...base, ageing: groups, group, cards, topCards: top })
    }
    const status = oneOf(c.req.query('status'), ['pending', 'approved', 'rejected'] as const, 'pending')
    return c.json({ ...base, status, requests: await paymentRequests(sap, { status, page }) })
  })

  /** Defaults and permissions for the Reports page. */
  app.get('/api/reports', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const [meta, settings] = await Promise.all([importMeta(sap), reportSettings(deps.store)])
    return c.json({
      dataAsOf: meta.dataAsOf,
      defaultDate: defaultReportDate(deps.now(), meta.dataAsOf),
      basis: settings.basis,
      cutoff: settings.cutoff,
      canSeeReport: FINANCE_ROLES.includes(user.role),
      canEditInputs: DAILY_INPUT_ROLES.includes(user.role),
      canChangeBasis: user.role === 'admin',
    })
  })

  app.put('/api/reports/settings', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only the admin can change how the report counts outwards' }, 403)
    const parsed = reportSettingsSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Choose created_window, doc_date or ewb_date' }, 400)
    await deps.store.saveSetting(SETTING_BASIS, parsed.data.outwardsBasis, user.id)
    return c.json({ basis: parsed.data.outwardsBasis })
  })

  app.get('/api/reports/daily-inputs/:date', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const date = c.req.param('date')
    if (!isIsoDay(date)) return c.json({ error: 'Use a date like 2026-07-15' }, 400)
    return c.json({ date, inputs: await deps.store.getDailyInputs(date), canEdit: DAILY_INPUT_ROLES.includes(user.role) })
  })

  app.put('/api/reports/daily-inputs/:date', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (!DAILY_INPUT_ROLES.includes(user.role)) return c.json({ error: 'Only the office (QA) or the admin enters the daily inputs' }, 403)
    const date = c.req.param('date')
    if (!isIsoDay(date)) return c.json({ error: 'Use a date like 2026-07-15' }, 400)
    const parsed = dailyInputsSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Check the numbers: counts are whole numbers, weights in kg' }, 400)
    const inputs = await deps.store.saveDailyInputs(date, parsed.data, { userId: user.id, at: deps.now() })
    return c.json({ date, inputs })
  })

  /** A day's report: /api/reports/daily/2026-07-15 is the preview payload, /api/reports/daily/2026-07-15.pdf the PDF. */
  app.get('/api/reports/daily/:file', async (c) => {
    const user = await userWithRole(c, FINANCE_ROLES)
    if (user instanceof Response) return user
    const file = c.req.param('file')
    const pdf = file.endsWith('.pdf')
    const date = pdf ? file.slice(0, -4) : file
    if (!isIsoDay(date)) return c.json({ error: 'Use a date like 2026-07-15' }, 400)
    if (!pdf) {
      const [payload, latest] = await Promise.all([buildDailyReport(deps, { date }), deps.store.latestDailyReport(date)])
      return c.json({ payload, latest: latest ? { id: latest.id, version: latest.version, createdAt: latest.createdAt, documentId: latest.documentId } : null })
    }
    const report = await generateDailyReport(deps, { date, userId: user.id, reuseUnchanged: true })
    c.header('content-type', 'application/pdf')
    c.header('content-disposition', inlineDisposition(report.fileName).replace(/^inline/, c.req.query('download') ? 'attachment' : 'inline'))
    c.header('x-content-type-options', 'nosniff')
    c.header('cache-control', 'no-store')
    return c.body(new Uint8Array(report.pdf))
  })

  /** "Send to my WhatsApp": the PDF to the requester's linked phone. */
  app.post('/api/reports/daily/:date/send', async (c) => {
    const user = await userWithRole(c, FINANCE_ROLES)
    if (user instanceof Response) return user
    const date = c.req.param('date')
    if (!isIsoDay(date)) return c.json({ error: 'Use a date like 2026-07-15' }, 400)
    const phone = (await deps.store.listAccountLinks()).find((account) => account.id === user.id)?.phoneNumber
    if (!phone) return c.json({ error: 'Link your WhatsApp number in Settings first' }, 409)
    const report = await generateDailyReport(deps, { date, userId: user.id })
    try {
      await sendReportTo(deps, dmAddress(phone), report)
    } catch {
      return c.json({ error: 'WhatsApp gateway is unavailable' }, 502)
    }
    return c.json({ sent: true, version: report.record.version, message: `Sent the report for ${date} to your WhatsApp.` })
  })

  // ------------------------------------------------------------------------------------------ P7: costing, payroll

  /** The Costing page (manager and admin): the month's KPIs, one table, the WIP-variance card. Material cost only. */
  app.get('/api/costing', async (c) => {
    const user = await userWithRole(c, FINANCE_ROLES)
    if (user instanceof Response) return user
    const meta = await importMeta(sap)
    if (!meta.dataAsOf) return c.json({ error: 'SAP data not imported yet' }, 503)
    const dataMonth = `${meta.dataAsOf.slice(0, 7)}-01`
    const month = monthOf(c.req.query('month')) ?? dataMonth
    const span = oneOf(c.req.query('span'), COSTING_SPANS, '1')
    const from = addMonths(month, 1 - Number(span))
    const tab = oneOf(c.req.query('tab'), COSTING_TABS, 'skus')
    const [kpis, months, wip] = await Promise.all([
      costingKpis(sap, month),
      costingMonths(sap),
      wipVariance(sap, addMonths(month, -11), month),
    ])
    const base = { asOf: meta.dataAsOf, month, span, from, to: month, months, tab, kpis, wip, note: NO_LABOUR }
    const q = c.req.query('q') || null
    if (tab === 'skus' || tab === 'customers') {
      const margins = await skuMargins(sap, { from, to: month, by: tab === 'skus' ? 'sku' : 'customer', q, limit: 200 })
      return c.json({ ...base, margins })
    }
    if (tab === 'orders') {
      return c.json({ ...base, orders: await productionCosts(sap, { from, to: lastDayOf(month), q, page: c.req.query('page') }) })
    }
    if (tab === 'mix') {
      return c.json({ ...base, mix: await materialMix(sap, addMonths(month, -5), month) })
    }
    return c.json({ ...base, valuation: await stockValuation(sap) })
  })

  /** One production order's cost (manager and admin). */
  app.get('/api/costing/production/:docEntry', async (c) => {
    const user = await userWithRole(c, FINANCE_ROLES)
    if (user instanceof Response) return user
    const docEntry = docEntryParam(c.req.param('docEntry'))
    const row = docEntry ? await productionCost(sap, { docEntry }) : null
    if (!row) return c.json({ error: 'Production order not found' }, 404)
    return c.json({ ...row, note: NO_LABOUR })
  })

  /**
   * The Payroll and attendance page: the admin only (403 for everyone else, and the nav hides it). From the HR files
   * (schema hr), not SAP: headcount, the month's payrolls by category, the attendance grid, the peeling incentive,
   * leave, and the month against SAP's salary journal and payments.
   */
  app.get('/api/payroll', async (c) => {
    const user = await userWithRole(c, PAYROLL_ROLES, 'Payroll is for the admin only')
    if (user instanceof Response) return user
    const meta = await hrOrNull(() => hrMeta(sap))
    if (!meta || meta.months.length === 0) return c.json({ error: 'HR data not imported yet' }, 503)
    const month = monthOf(c.req.query('month')) ?? meta.months[0]!
    const attendanceMonthKey = meta.attendanceMonths.includes(month) ? month : (meta.attendanceMonths[0] ?? null)
    const peelingKey = monthOf(c.req.query('peeling')) ?? meta.peelingMonths[0] ?? null
    const [summary, people, attendance, peeling, leave, rec] = await Promise.all([
      payrollSummary(sap, month),
      headcount(sap),
      attendanceMonthKey ? attendanceMonth(sap, attendanceMonthKey, { names: true }) : Promise.resolve(null),
      peelingKey && meta.peelingMonths.includes(peelingKey) ? peelingMonth(sap, peelingKey, { names: true, limit: 60 }) : Promise.resolve(null),
      leaveSummary(sap, {}),
      reconciliation(sap, month).catch((error: unknown) => {
        if (isNotImported(error)) return null
        throw error
      }),
    ])
    return c.json({
      importedAt: meta.importedAt,
      months: meta.months,
      peelingMonths: meta.peelingMonths,
      month,
      payroll: summary,
      headcount: people,
      attendance,
      peeling,
      leave,
      reconciliation: rec,
    })
  })

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
    if (parsed.data.action) {
      const decided = await decideFromDesk(deps, task, user, parsed.data.action, parsed.data.note ?? '')
      if (!decided.ok) return c.json({ error: decided.error }, decided.status)
      return c.json({ task: await deps.store.getTask(id), message: decided.message })
    }
    if (task.kind === 'approval' && parsed.data.status === 'done') {
      return c.json({ error: 'An approval closes when it is approved, sent back or rejected' }, 409)
    }
    if (task.kind === 'approval' && user.role !== 'admin') {
      return c.json({ error: 'Only the admin can change an approval task' }, 403)
    }
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

  app.get('/api/my-day', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const tasks = await deps.store.listTasks()
    const day = myDay(tasks, user, deps.now())
    return c.json({ ...day, approvals: await approvalCards(deps, [...day.open, ...day.closedToday]) })
  })

  app.get('/api/nav-counts', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const day = myDay(await deps.store.listTasks(), user, deps.now())
    const approvals = user.role === 'admin' ? (await pendingApprovals(deps)).length : 0
    return c.json({ myDay: day.open.length, approvals })
  })

  app.get('/api/approvals', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const page = pageRequest(c.req.query('page'), 25)
    const [pending, decided, sapHistory] = await Promise.all([
      pendingApprovals(deps),
      deps.store.listApprovals({ subjectType: 'sales_order', limit: 100 }),
      approvalHistory(sap, { docObject: '17', limit: page.pageSize, offset: page.offset }).catch((error: unknown) => {
        if (isNotImported(error)) return { rows: [], total: 0 }
        throw error
      }),
    ])
    return c.json({
      canDecide: user.role === 'admin',
      pending: await approvalViews(deps, pending),
      decided: await approvalViews(deps, decided.filter((row) => row.status !== 'pending')),
      sap: { ...sapHistory, page: page.page, pageSize: page.pageSize },
    })
  })

  app.get('/api/sales-orders', async (c) => {
    const status = c.req.query('status')
    const rows = await deps.store.listSalesOrders({
      status: (SALES_ORDER_STATUSES as readonly string[]).includes(status ?? '') ? (status as SalesOrderStatus) : null,
      limit: 200,
    })
    return c.json({ rows: rows.map(salesOrderSummary) })
  })

  app.get('/api/sales-orders/:id', async (c) => {
    const order = (await deps.store.getSalesOrder(c.req.param('id'))) ?? (await deps.store.findSalesOrderByNo(decodeURIComponent(c.req.param('id'))))
    if (!order) return c.json({ error: 'Sales order not found' }, 404)
    const view = await salesOrderView(deps, order)
    const card = (await cardInfo(sap, [order.cardCode]).catch(() => ({}) as Awaited<ReturnType<typeof cardInfo>>))[order.cardCode]
    return c.json({ ...view, cardName: card?.cardName ?? null, group: await customerGroupFor(deps, order) })
  })

  /** Cancel a TSO (admin): its stock is free again, its tasks and requests are cancelled, a pending send is stopped. */
  app.post('/api/sales-orders/:id/cancel', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const parsed = noteSchema.safeParse(await c.req.json().catch(() => null))
    const note = parsed.success ? (parsed.data?.note ?? '') : ''
    const result = await cancelSalesOrder(deps, c.req.param('id'), { userId: user.id, name: user.name, role: user.role }, note)
    if (!result.ok) return c.json({ error: result.text }, result.status)
    const order = await deps.store.getSalesOrder(c.req.param('id'))
    return c.json({ message: result.text, order: order ? salesOrderSummary(order) : null })
  })

  /** Cancel an unposted receipt recorded by mistake: the manager, the admin or whoever recorded it. */
  app.post('/api/stock-adjustments/:id/cancel', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const adjustment = await deps.store.getStockAdjustment(c.req.param('id'))
    if (!adjustment) return c.json({ error: 'Receipt not found' }, 404)
    if (user.role === 'office' && adjustment.createdBy !== user.id) {
      return c.json({ error: 'Only the manager, the admin or whoever recorded it can cancel it' }, 403)
    }
    const closed = await deps.store.closeStockAdjustment(adjustment.id, 'cancelled', `Cancelled by ${user.name}.`, deps.now())
    if (!closed) return c.json({ error: `That receipt is already ${adjustment.status}` }, 409)
    return c.json({ adjustment: closed })
  })

  /** Catch up with the latest SAP import now (admin): link TSOs keyed into SAP, absorb receipts with a GRN. */
  app.post('/api/sap-sync', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can run this' }, 403)
    return c.json(await syncWithSap(deps))
  })

  app.post('/api/stock-adjustments', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const parsed = adjustmentSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Give an item code and a quantity' }, 400)
    const result = await recordReceipt(
      deps,
      [{ itemCode: parsed.data.itemCode.toUpperCase(), qty: parsed.data.qty, unit: normaliseUnit(parsed.data.unit) }],
      { userId: user.id },
      'dashboard',
    )
    if (!result.recorded.length) return c.json({ error: result.problems.join(' ') || 'Not recorded' }, 400)
    return c.json({ adjustment: result.recorded[0], message: result.text }, 201)
  })

  app.get('/api/agent', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    return c.json(await listDeskMessages(deps, user.id))
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
    return c.json({ message: result.message }, 202)
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

  /**
   * The bot's WhatsApp groups (from the gateway) with the customer each is mapped to. Groups only known from
   * earlier messages are listed too; when the gateway is down the stored groups still come back, with an error.
   */
  app.get('/api/whatsapp/groups', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can list WhatsApp groups' }, 403)
    const stored = await deps.store.listWaGroups()
    let live: Awaited<ReturnType<typeof deps.evolution.fetchAllGroups>> = []
    let error: string | null = null
    try {
      live = await deps.evolution.fetchAllGroups()
    } catch {
      error = 'WhatsApp gateway is unavailable'
    }
    const groups = [
      ...live.map((group) => {
        const row = stored.find((entry) => entry.jid === group.id)
        return { ...group, partyGroupId: row?.partyGroupId ?? null, sendSo: row?.sendSo ?? true, inGroup: true }
      }),
      ...stored
        .filter((row) => !live.some((group) => group.id === row.jid))
        .map((row) => ({ id: row.jid, subject: row.subject ?? row.jid, size: null, partyGroupId: row.partyGroupId, sendSo: row.sendSo, inGroup: !error ? false : null })),
    ]
    return c.json(error ? { groups, error } : { groups })
  })

  app.get('/api/whatsapp/groups/:jid', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const group = await deps.store.getWaGroup(c.req.param('jid'))
    if (!group) return c.json({ error: 'That WhatsApp group is not known yet' }, 404)
    return c.json({ group })
  })

  app.put('/api/whatsapp/groups/:jid', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can map WhatsApp groups' }, 403)
    const jid = c.req.param('jid')
    if (!/^[\w.-]+@g\.us$/.test(jid)) return c.json({ error: 'That is not a WhatsApp group id' }, 400)
    const parsed = waGroupSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Choose a party group (or none) and whether to send sales orders' }, 400)
    const { partyGroupId, sendSo } = parsed.data
    if (partyGroupId && !(await deps.store.getPartyGroup(partyGroupId))) {
      return c.json({ error: 'That party group does not exist' }, 404)
    }
    let subject = (await deps.store.getWaGroup(jid))?.subject ?? null
    if (!subject) subject = (await deps.evolution.fetchAllGroups().catch(() => [])).find((group) => group.id === jid)?.subject ?? null
    const group = await deps.store.saveWaGroup(jid, {
      ...(partyGroupId !== undefined ? { partyGroupId } : {}),
      ...(sendSo !== undefined ? { sendSo } : {}),
      ...(subject ? { subject } : {}),
    })
    return c.json({ group })
  })

  /** Party groups with their members (and member card names), customer sites and item refs (read-only). */
  app.get('/api/party-groups', async (c) => {
    const [groups, sites, refs] = await Promise.all([
      deps.store.listPartyGroups(),
      deps.store.listCustomerSites(),
      deps.store.listCustomerItemRefs(),
    ])
    const codes = [...new Set([...groups.flatMap((g) => g.members.filter((m) => m.kind === 'card_code').map((m) => m.value)), ...sites.map((site) => site.cardCode)])]
    const names = await cardInfo(sap, codes).catch((error: unknown) => {
      if (isNotImported(error)) return {} as Awaited<ReturnType<typeof cardInfo>>
      throw error
    })
    return c.json({
      partyGroups: groups.map((group) => ({
        ...group,
        members: group.members.map((member) => ({ ...member, name: member.kind === 'card_code' ? (names[member.value]?.cardName ?? null) : null })),
        sites: sites.filter((site) => site.partyGroupId === group.id).map((site) => ({ ...site, cardName: names[site.cardCode]?.cardName ?? null })),
        itemRefs: refs.filter((ref) => ref.partyGroupId === group.id),
      })),
    })
  })

  async function writePartyGroup(c: Context, id: string | null) {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can change party groups' }, 403)
    const parsed = partyGroupSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Give the party group a name and its PANs or card codes' }, 400)
    const pan = parsed.data.members.find((member) => member.kind === 'pan' && !/^[A-Za-z]{5}\d{4}[A-Za-z]$/.test(member.value.trim()))
    if (pan) return c.json({ error: `${pan.value} is not a PAN (5 letters, 4 digits, 1 letter)` }, 400)
    try {
      if (!id) return c.json({ partyGroup: await deps.store.createPartyGroup(parsed.data) }, 201)
      const updated = await deps.store.updatePartyGroup(id, parsed.data)
      if (!updated) return c.json({ error: 'Party group not found' }, 404)
      return c.json({ partyGroup: updated })
    } catch (error) {
      if (error instanceof PartyGroupConflictError) return c.json({ error: error.message }, 409)
      throw error
    }
  }

  app.post('/api/party-groups', (c) => writePartyGroup(c, null))
  app.put('/api/party-groups/:id', (c) => writePartyGroup(c, c.req.param('id')))
  app.delete('/api/party-groups/:id', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    if (user.role !== 'admin') return c.json({ error: 'Only an admin can change party groups' }, 403)
    if (!(await deps.store.deletePartyGroup(c.req.param('id')))) return c.json({ error: 'Party group not found' }, 404)
    return c.json({ ok: true })
  })

  app.get('/api/customer-pos', async (c) => {
    const status = c.req.query('status')
    const rows = await deps.store.listCustomerPos({
      limit: 200,
      status: status && (CUSTOMER_PO_STATUSES as readonly string[]).includes(status) ? status : null,
    })
    return c.json({ rows })
  })

  app.get('/api/customer-pos/:id', async (c) => {
    const po = await deps.store.getCustomerPo(c.req.param('id'))
    if (!po) return c.json({ error: 'Customer PO not found' }, 404)
    const [check, tasks] = await Promise.all([deps.store.latestInventoryCheck(po.id), deps.store.listTasks()])
    const card = po.cardCode
      ? ((await cardInfo(sap, [po.cardCode]).catch((error: unknown) => {
          if (isNotImported(error)) return {} as Awaited<ReturnType<typeof cardInfo>>
          throw error
        }))[po.cardCode] ?? null)
      : null
    const document = po.documentId ? await deps.store.getDocument(po.documentId) : null
    const salesOrder = await deps.store.findSalesOrderForPo(po.id)
    return c.json({
      salesOrder: salesOrder ? salesOrderSummary(salesOrder) : null,
      po,
      cardName: card?.cardName ?? null,
      check,
      document: document && po.documentId ? { id: po.documentId, filename: document.filename } : null,
      tasks: tasks.filter((task) => task.subjectType === 'customer_po' && task.subjectId === po.id),
    })
  })

  /** The office's review of a PO in needs_review: the customer card and each line's item (any signed-in role). */
  app.put('/api/customer-pos/:id/review', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const parsed = poReviewSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'Choose a customer card or the items of the lines' }, 400)
    try {
      const po = await reviewPo(deps, c.req.param('id'), parsed.data)
      return c.json({ po })
    } catch (error) {
      if (error instanceof PoReviewError) return c.json({ error: error.message }, 400)
      throw error
    }
  })

  /** "Confirm and check": check the reviewed PO again and carry on (TSO, hold, or a repeat waiting for *proceed*). */
  app.post('/api/customer-pos/:id/confirm', async (c) => {
    const user = await userFrom(c.req.header('cookie'))
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    try {
      const result = await confirmPoReview(deps, c.req.param('id'))
      await notifyAdmin(deps, await deps.store.listAccountLinks(), result.summary, { subjectType: 'customer_po', subjectId: result.po.id }).catch(
        (error: unknown) => console.error('Could not send the admin the confirmed PO', error),
      )
      return c.json({ po: result.po, check: result.check, message: result.next })
    } catch (error) {
      if (error instanceof PoReviewError) return c.json({ error: error.message }, 409)
      throw error
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
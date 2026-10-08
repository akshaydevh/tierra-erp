import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, lt, lte, ne, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'
import type { RecentMessage, Store, ThreadMessage } from './store'
import type {
  AccountLink,
  Balance,
  ChatContext,
  ClaimedMessage,
  Customer,
  Item,
  JobRecord,
  JobStatus,
  MessageKind,
  NewJob,
  NewTask,
  OrderLineRecord,
  NewOrderLine,
  OrderRecord,
  PendingConfirmation,
  ProcurementOrderRecord,
  ProductionPlan,
  ProductionEntryRecord,
  PublicUser,
  Role,
  StoredDocument,
  StoredMessage,
  TaskRecord,
  TaskStatus,
  User,
  WhatsappConnection,
  WhatsappStatus,
} from './types'
import {
  JOB_STATUSES,
  MESSAGE_KINDS,
  asItemKind,
  asRole,
  asTaskCategory,
  asTaskKind,
  asTaskStatus,
  asTaskVia,
  orderSourceForThread,
  toPublicUser,
} from './types'

type Database = PostgresJsDatabase<typeof schema>

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function asJobStatus(value: string): JobStatus {
  if ((JOB_STATUSES as readonly string[]).includes(value)) return value as JobStatus
  throw new Error(`Unknown job status ${value}`)
}

function asMessageKind(value: string): MessageKind {
  if ((MESSAGE_KINDS as readonly string[]).includes(value)) return value as MessageKind
  throw new Error(`Unknown message kind ${value}`)
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const pg = current as Error & { code?: string; constraint_name?: string }
    if (pg.code === '23505' && pg.constraint_name === constraint) return true
  }
  return false
}

function toJob(row: typeof schema.jobs.$inferSelect): JobRecord {
  return {
    id: row.id,
    kind: row.kind,
    payload: row.payload,
    status: asJobStatus(row.status),
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAfter: row.runAfter.toISOString(),
    lockedUntil: row.lockedUntil?.toISOString() ?? null,
    idempotencyKey: row.idempotencyKey,
    lastError: row.lastError,
  }
}

const liveSubject = sql.raw(`subject_type is not null and status <> 'cancelled'`)

const defaultConnection = (): WhatsappConnection => ({
  instanceName: 'tierra',
  status: 'disconnected',
  qrBase64: null,
  phoneNumber: null,
})

export class DrizzleStore implements Store {
  constructor(private readonly db: Database) {}

  async findUserByEmail(email: string): Promise<User | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.email, email.toLowerCase())).limit(1)
    if (!row) return null
    return { ...row, role: asRole(row.role) }
  }

  async createSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    await this.db.insert(schema.sessions).values({
      id: newId('ses'),
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
    })
  }

  async findUserByTokenHash(tokenHash: string, now: Date): Promise<PublicUser | null> {
    const [row] = await this.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        name: schema.users.name,
        role: schema.users.role,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(and(eq(schema.sessions.tokenHash, tokenHash), gt(schema.sessions.expiresAt, now)))
      .limit(1)
    return row ? toPublicUser({ ...row, role: asRole(row.role) }) : null
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.delete(schema.sessions).where(eq(schema.sessions.tokenHash, tokenHash))
  }

  async listAccountLinks(): Promise<AccountLink[]> {
    const [people, relations] = await Promise.all([
      this.db
        .select({
          id: schema.users.id,
          name: schema.users.name,
          email: schema.users.email,
          role: schema.users.role,
        })
        .from(schema.users)
        .orderBy(schema.users.name),
      this.db
        .select({
          userId: schema.accountRelations.userId,
          phoneNumber: schema.accountRelations.phoneNumber,
        })
        .from(schema.accountRelations),
    ])
    return people.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: asRole(user.role),
      phoneNumber: relations.find((row) => row.userId === user.id)?.phoneNumber ?? null,
    }))
  }

  async saveRelation(input: { userId: string; phoneNumber: string }): Promise<void> {
    await this.db
      .insert(schema.accountRelations)
      .values({
        id: newId('rel'),
        userId: input.userId,
        phoneNumber: input.phoneNumber,
      })
      .onConflictDoUpdate({
        target: schema.accountRelations.userId,
        set: { phoneNumber: input.phoneNumber },
      })
  }

  async deleteRelation(userId: string): Promise<void> {
    await this.db.delete(schema.accountRelations).where(eq(schema.accountRelations.userId, userId))
  }

  async updateUserRole(userId: string, role: Role): Promise<'ok' | 'not_found' | 'admin_taken'> {
    try {
      const updated = await this.db
        .update(schema.users)
        .set({ role })
        .where(eq(schema.users.id, userId))
        .returning({ id: schema.users.id })
      return updated.length > 0 ? 'ok' : 'not_found'
    } catch (error) {
      if (isUniqueViolation(error, 'users_single_admin')) return 'admin_taken'
      throw error
    }
  }

  async listCustomers(): Promise<Customer[]> {
    return this.db.select().from(schema.customers).orderBy(schema.customers.name)
  }

  async listItems(): Promise<Item[]> {
    const rows = await this.db.select().from(schema.items).orderBy(schema.items.sku)
    return rows.map((row) => ({ ...row, kind: asItemKind(row.kind) }))
  }

  async listBalances(): Promise<Balance[]> {
    const rows = await this.db.select().from(schema.inventoryBalances)
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      itemId: row.itemId,
      onHand: row.onHand,
    }))
  }

  async listOrders(): Promise<OrderRecord[]> {
    const rows = await this.db
      .select({
        id: schema.orders.id,
        customerId: schema.orders.customerId,
        customerName: schema.customers.name,
        poNumber: schema.orders.poNumber,
        poDate: schema.orders.poDate,
        status: schema.orders.status,
        source: schema.orders.source,
        createdAt: schema.orders.createdAt,
      })
      .from(schema.orders)
      .innerJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .orderBy(desc(schema.orders.createdAt))
    return rows.map((row) => ({
      id: row.id,
      customerId: row.customerId,
      customerName: row.customerName,
      poNumber: row.poNumber,
      poDate: row.poDate,
      status: row.status as OrderRecord['status'],
      source: row.source as OrderRecord['source'],
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async listOrderLines(): Promise<OrderLineRecord[]> {
    const rows = await this.db
      .select({
        id: schema.orderLines.id,
        orderId: schema.orderLines.orderId,
        itemId: schema.orderLines.itemId,
        sku: schema.items.sku,
        itemName: schema.items.name,
        description: schema.orderLines.description,
        quantity: schema.orderLines.quantity,
        unit: schema.orderLines.unit,
        unitPrice: schema.orderLines.unitPrice,
      })
      .from(schema.orderLines)
      .innerJoin(schema.items, eq(schema.items.id, schema.orderLines.itemId))
    return rows
  }

  async orderHasDocument(orderId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.orderDocuments.id })
      .from(schema.orderDocuments)
      .where(eq(schema.orderDocuments.orderId, orderId))
      .limit(1)
    return Boolean(row)
  }

  async getOrderDocument(orderId: string): Promise<StoredDocument | null> {
    const [row] = await this.db
      .select({
        filename: schema.orderDocuments.filename,
        mimeType: schema.orderDocuments.mimeType,
        content: schema.orderDocuments.content,
      })
      .from(schema.orderDocuments)
      .where(eq(schema.orderDocuments.orderId, orderId))
      .limit(1)
    return row ?? null
  }

  async getWhatsapp(): Promise<WhatsappConnection> {
    const [row] = await this.db
      .select()
      .from(schema.whatsappConnection)
      .where(eq(schema.whatsappConnection.id, 'default'))
      .limit(1)
    if (!row) return defaultConnection()
    return {
      instanceName: row.instanceName,
      status: row.status as WhatsappStatus,
      qrBase64: row.qrBase64,
      phoneNumber: row.phoneNumber,
    }
  }

  async saveWhatsapp(
    patch: Partial<Pick<WhatsappConnection, 'status' | 'qrBase64' | 'phoneNumber'>>,
  ): Promise<WhatsappConnection> {
    const current = await this.getWhatsapp()
    const next = { ...current, ...patch }
    await this.db
      .insert(schema.whatsappConnection)
      .values({
        id: 'default',
        instanceName: 'tierra',
        status: next.status,
        qrBase64: next.qrBase64,
        phoneNumber: next.phoneNumber,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.whatsappConnection.id,
        set: {
          status: next.status,
          qrBase64: next.qrBase64,
          phoneNumber: next.phoneNumber,
          updatedAt: new Date(),
        },
      })
    return next
  }

  async claimMessage(message: ClaimedMessage): Promise<boolean> {
    const inserted = await this.db
      .insert(schema.whatsappMessages)
      .values({
        id: newId('msg'),
        evolutionMessageId: message.evolutionMessageId,
        remoteJid: message.remoteJid,
        fromMe: message.fromMe,
        hasPdf: message.hasPdf,
        body: message.body,
        senderJid: message.senderJid ?? null,
        quotedId: message.quotedId ?? null,
        kind: message.kind ?? 'text',
        purpose: message.purpose ?? null,
        subjectType: message.subjectType ?? null,
        subjectId: message.subjectId ?? null,
        status: message.status ?? null,
        idempotencyKey: message.idempotencyKey ?? null,
      })
      .onConflictDoNothing({ target: schema.whatsappMessages.evolutionMessageId })
      .returning({ id: schema.whatsappMessages.id })
    return inserted.length > 0
  }

  async findMessage(evolutionMessageId: string): Promise<StoredMessage | null> {
    const [row] = await this.db
      .select()
      .from(schema.whatsappMessages)
      .where(eq(schema.whatsappMessages.evolutionMessageId, evolutionMessageId))
      .limit(1)
    if (!row) return null
    return {
      evolutionMessageId: row.evolutionMessageId,
      remoteJid: row.remoteJid,
      fromMe: row.fromMe,
      body: row.body,
      kind: asMessageKind(row.kind),
      purpose: row.purpose,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async saveIdentity(lid: string, phone: string): Promise<void> {
    await this.db
      .insert(schema.waIdentities)
      .values({ lid, phone })
      .onConflictDoUpdate({ target: schema.waIdentities.lid, set: { phone, updatedAt: new Date() } })
  }

  async phoneForLid(lid: string): Promise<string | null> {
    const [row] = await this.db
      .select({ phone: schema.waIdentities.phone })
      .from(schema.waIdentities)
      .where(eq(schema.waIdentities.lid, lid))
      .limit(1)
    return row?.phone ?? null
  }

  async getChatContext(chatJid: string): Promise<ChatContext | null> {
    const [row] = await this.db
      .select()
      .from(schema.chatContext)
      .where(eq(schema.chatContext.chatJid, chatJid))
      .limit(1)
    if (!row) return null
    return { ...row, updatedAt: row.updatedAt.toISOString() }
  }

  async setChatContext(chatJid: string, subjectType: string, subjectId: string): Promise<void> {
    await this.db
      .insert(schema.chatContext)
      .values({ chatJid, subjectType, subjectId })
      .onConflictDoUpdate({
        target: schema.chatContext.chatJid,
        set: { subjectType, subjectId, updatedAt: new Date() },
      })
  }

  async listRecentMessages(remoteJids: string[], limit: number): Promise<RecentMessage[]> {
    if (remoteJids.length === 0 || limit <= 0) return []
    const rows = await this.db
      .select({
        remoteJid: schema.whatsappMessages.remoteJid,
        fromMe: schema.whatsappMessages.fromMe,
        body: schema.whatsappMessages.body,
      })
      .from(schema.whatsappMessages)
      .where(inArray(schema.whatsappMessages.remoteJid, remoteJids))
      .orderBy(desc(schema.whatsappMessages.createdAt))
      .limit(limit)
    return rows.reverse()
  }

  async listThread(remoteJid: string): Promise<ThreadMessage[]> {
    const rows = await this.db
      .select({
        id: schema.whatsappMessages.evolutionMessageId,
        fromMe: schema.whatsappMessages.fromMe,
        hasPdf: schema.whatsappMessages.hasPdf,
        body: schema.whatsappMessages.body,
        createdAt: schema.whatsappMessages.createdAt,
        filename: schema.orderDocuments.filename,
      })
      .from(schema.whatsappMessages)
      .leftJoin(
        schema.orderDocuments,
        eq(schema.orderDocuments.messageId, schema.whatsappMessages.evolutionMessageId),
      )
      .where(eq(schema.whatsappMessages.remoteJid, remoteJid))
      .orderBy(asc(schema.whatsappMessages.createdAt))
    const thread = new Map<string, ThreadMessage>()
    for (const row of rows) {
      const existing = thread.get(row.id)
      if (existing) {
        if (!existing.filename && row.filename) existing.filename = row.filename
        continue
      }
      thread.set(row.id, {
        id: row.id,
        fromMe: row.fromMe,
        hasPdf: row.hasPdf,
        body: row.body,
        filename: row.filename,
        createdAt: row.createdAt.toISOString(),
      })
    }
    return [...thread.values()]
  }

  async releaseMessage(evolutionMessageId: string): Promise<void> {
    await this.db
      .delete(schema.whatsappMessages)
      .where(eq(schema.whatsappMessages.evolutionMessageId, evolutionMessageId))
  }

  async insertDocument(input: StoredDocument & { messageId: string }): Promise<string> {
    const id = newId('doc')
    await this.db.insert(schema.orderDocuments).values({
      id,
      messageId: input.messageId,
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
    })
    return id
  }

  async listProductionEntries(): Promise<ProductionEntryRecord[]> {
    const rows = await this.db
      .select({
        id: schema.productionEntries.id,
        orderId: schema.productionEntries.orderId,
        poNumber: schema.orders.poNumber,
        customerName: schema.customers.name,
        finishedGoodsKg: schema.productionEntries.finishedGoodsKg,
        kgBananaPerKgChips: schema.productionEntries.kgBananaPerKgChips,
        bananaKg: schema.productionEntries.bananaKg,
        sourceMonths: schema.productionEntries.sourceMonths,
        createdAt: schema.productionEntries.createdAt,
      })
      .from(schema.productionEntries)
      .innerJoin(schema.orders, eq(schema.orders.id, schema.productionEntries.orderId))
      .innerJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .orderBy(desc(schema.productionEntries.createdAt))
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async listProcurementOrders(): Promise<ProcurementOrderRecord[]> {
    const pendingCustomer = alias(schema.customers, 'pending_customer')
    const rows = await this.db
      .select({
        id: schema.procurementOrders.id,
        orderId: schema.procurementOrders.orderId,
        orderPoNumber: schema.orders.poNumber,
        pendingPoNumber: schema.pendingOrders.poNumber,
        orderCustomerName: schema.customers.name,
        pendingCustomerName: pendingCustomer.name,
        productionEntryId: schema.procurementOrders.productionEntryId,
        itemName: schema.items.name,
        quantityKg: schema.procurementOrders.quantityKg,
        unit: schema.procurementOrders.unit,
        assigneeId: schema.procurementOrders.assigneeId,
        assigneeName: schema.users.name,
        createdAt: schema.procurementOrders.createdAt,
      })
      .from(schema.procurementOrders)
      .leftJoin(schema.orders, eq(schema.orders.id, schema.procurementOrders.orderId))
      .leftJoin(schema.customers, eq(schema.customers.id, schema.orders.customerId))
      .leftJoin(schema.pendingOrders, eq(schema.pendingOrders.id, schema.procurementOrders.pendingOrderId))
      .leftJoin(pendingCustomer, eq(pendingCustomer.id, schema.pendingOrders.customerId))
      .innerJoin(schema.items, eq(schema.items.id, schema.procurementOrders.itemId))
      .innerJoin(schema.users, eq(schema.users.id, schema.procurementOrders.assigneeId))
      .orderBy(desc(schema.procurementOrders.createdAt))
    return rows.map((row) => ({
      id: row.id,
      orderId: row.orderId,
      poNumber: row.orderPoNumber ?? row.pendingPoNumber ?? '',
      customerName: row.orderCustomerName ?? row.pendingCustomerName ?? '',
      productionEntryId: row.productionEntryId,
      itemName: row.itemName,
      quantityKg: row.quantityKg,
      unit: row.unit,
      assigneeId: row.assigneeId,
      assigneeName: row.assigneeName,
      createdAt: row.createdAt.toISOString(),
    }))
  }

  async holdShortOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    remoteJid: string
    documentId: string
    lines: NewOrderLine[]
    shortages: Array<{ itemId: string; quantity: number; unit: string }>
    assigneeId: string
  }): Promise<{ id: string }> {
    const id = newId('pnd')
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.pendingOrders).values({
        id,
        customerId: input.customerId,
        poNumber: input.poNumber,
        poDate: input.poDate,
        remoteJid: input.remoteJid,
        documentId: input.documentId,
        status: 'awaiting_admin',
      })
      for (const line of input.lines) {
        await tx.insert(schema.pendingOrderLines).values({
          id: newId('pln'),
          pendingOrderId: id,
          itemId: line.itemId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
        })
      }
      for (const shortage of input.shortages) {
        await tx.insert(schema.procurementOrders).values({
          id: newId('prc'),
          pendingOrderId: id,
          itemId: shortage.itemId,
          quantityKg: String(shortage.quantity),
          unit: shortage.unit,
          assigneeId: input.assigneeId,
        })
      }
    })
    return { id }
  }

  async findAwaitingConfirmation(remoteJid: string): Promise<PendingConfirmation | null> {
    const pending = await this.db
      .select()
      .from(schema.pendingOrders)
      .where(and(eq(schema.pendingOrders.remoteJid, remoteJid), eq(schema.pendingOrders.status, 'awaiting_admin')))
      .orderBy(desc(schema.pendingOrders.createdAt))
      .limit(1)
    const row = pending[0]
    if (!row) return null
    const lines = await this.db
      .select()
      .from(schema.pendingOrderLines)
      .where(eq(schema.pendingOrderLines.pendingOrderId, row.id))
    return {
      id: row.id,
      poNumber: row.poNumber,
      lines: lines.map((line) => ({
        itemId: line.itemId,
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
      })),
    }
  }

  async confirmPendingOrder(
    id: string,
    production: ProductionPlan | null,
  ): Promise<{ id: string; poNumber: string; productionEntryId: string | null; procurementOrderId: string | null } | null> {
    return this.db.transaction(async (tx) => {
      const pendingRows = await tx
        .select()
        .from(schema.pendingOrders)
        .where(and(eq(schema.pendingOrders.id, id), eq(schema.pendingOrders.status, 'awaiting_admin')))
        .limit(1)
      const pending = pendingRows[0]
      if (!pending) return null
      const lines = await tx
        .select()
        .from(schema.pendingOrderLines)
        .where(eq(schema.pendingOrderLines.pendingOrderId, pending.id))
      const orderId = newId('ord')
      await tx.insert(schema.orders).values({
        id: orderId,
        customerId: pending.customerId,
        poNumber: pending.poNumber,
        poDate: pending.poDate,
        status: 'open',
        source: orderSourceForThread(pending.remoteJid),
      })
      for (const line of lines) {
        await tx.insert(schema.orderLines).values({
          id: newId('lin'),
          orderId,
          itemId: line.itemId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
        })
      }
      if (pending.documentId) {
        await tx
          .update(schema.orderDocuments)
          .set({ orderId })
          .where(eq(schema.orderDocuments.id, pending.documentId))
      }
      await tx
        .update(schema.procurementOrders)
        .set({ orderId })
        .where(eq(schema.procurementOrders.pendingOrderId, pending.id))
      await tx.update(schema.pendingOrders).set({ status: 'confirmed' }).where(eq(schema.pendingOrders.id, pending.id))
      if (!production) return { id: orderId, poNumber: pending.poNumber, productionEntryId: null, procurementOrderId: null }
      const productionEntryId = newId('prd')
      const procurementOrderId = newId('prc')
      await tx.insert(schema.productionEntries).values({
        id: productionEntryId,
        orderId,
        finishedGoodsKg: production.finishedGoodsKg,
        kgBananaPerKgChips: production.kgBananaPerKgChips,
        bananaKg: production.bananaKg,
        sourceMonths: production.sourceMonths,
      })
      await tx.insert(schema.procurementOrders).values({
        id: procurementOrderId,
        orderId,
        productionEntryId,
        itemId: production.rawItemId,
        quantityKg: production.bananaKg,
        unit: 'kg',
        assigneeId: production.assigneeId,
      })
      return { id: orderId, poNumber: pending.poNumber, productionEntryId, procurementOrderId }
    })
  }

  async declinePendingOrder(id: string): Promise<{ poNumber: string } | null> {
    const pendingRows = await this.db
      .select()
      .from(schema.pendingOrders)
      .where(and(eq(schema.pendingOrders.id, id), eq(schema.pendingOrders.status, 'awaiting_admin')))
      .limit(1)
    const pending = pendingRows[0]
    if (!pending) return null
    await this.db.update(schema.pendingOrders).set({ status: 'declined' }).where(eq(schema.pendingOrders.id, pending.id))
    return { poNumber: pending.poNumber }
  }

  async createOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    remoteJid: string
    lines: import('./types').NewOrderLine[]
    document: StoredDocument & { messageId: string }
    production: import('./types').ProductionPlan | null
  }): Promise<{ id: string; productionEntryId: string | null; procurementOrderId: string | null }> {
    return this.db.transaction(async (tx) => {
      const id = newId('ord')
      await tx.insert(schema.orders).values({
        id,
        customerId: input.customerId,
        poNumber: input.poNumber,
        poDate: input.poDate,
        status: 'open',
        source: orderSourceForThread(input.remoteJid),
      })
      for (const line of input.lines) {
        await tx.insert(schema.orderLines).values({
          id: newId('lin'),
          orderId: id,
          itemId: line.itemId,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
        })
      }
      await tx.insert(schema.orderDocuments).values({
        id: newId('doc'),
        orderId: id,
        messageId: input.document.messageId,
        filename: input.document.filename,
        mimeType: input.document.mimeType,
        content: input.document.content,
      })
      if (!input.production) return { id, productionEntryId: null, procurementOrderId: null }
      const productionEntryId = newId('prd')
      const procurementOrderId = newId('prc')
      await tx.insert(schema.productionEntries).values({
        id: productionEntryId,
        orderId: id,
        finishedGoodsKg: input.production.finishedGoodsKg,
        kgBananaPerKgChips: input.production.kgBananaPerKgChips,
        bananaKg: input.production.bananaKg,
        sourceMonths: input.production.sourceMonths,
      })
      await tx.insert(schema.procurementOrders).values({
        id: procurementOrderId,
        orderId: id,
        productionEntryId,
        itemId: input.production.rawItemId,
        quantityKg: input.production.bananaKg,
        unit: 'kg',
        assigneeId: input.production.assigneeId,
      })
      return { id, productionEntryId, procurementOrderId }
    })
  }

  private async selectTasks(where: SQL): Promise<TaskRecord[]> {
    const assignee = alias(schema.users, 'task_assignee')
    const creator = alias(schema.users, 'task_creator')
    const rows = await this.db
      .select({ task: schema.tasks, assigneeName: assignee.name, createdByName: creator.name })
      .from(schema.tasks)
      .leftJoin(assignee, eq(assignee.id, schema.tasks.assigneeId))
      .leftJoin(creator, eq(creator.id, schema.tasks.createdBy))
      .where(where)
      .orderBy(desc(schema.tasks.createdAt), desc(schema.tasks.id))
    return rows.map(({ task, assigneeName, createdByName }) => ({
      id: task.id,
      title: task.title,
      category: asTaskCategory(task.category),
      status: asTaskStatus(task.status),
      kind: asTaskKind(task.kind),
      assigneeId: task.assigneeId,
      assigneeName,
      assigneeRole: task.assigneeRole ? asRole(task.assigneeRole) : null,
      description: task.description,
      dueAt: task.dueAt?.toISOString() ?? null,
      subjectType: task.subjectType,
      subjectId: task.subjectId,
      notifiedAt: task.notifiedAt?.toISOString() ?? null,
      waMessageId: task.waMessageId,
      createdVia: asTaskVia(task.createdVia),
      createdBy: task.createdBy,
      createdByName,
      createdAt: task.createdAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
    }))
  }

  async listTasks(): Promise<TaskRecord[]> {
    return this.selectTasks(sql`true`)
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const [task] = await this.selectTasks(eq(schema.tasks.id, id))
    return task ?? null
  }

  async listOpenTasksForUser(userId: string): Promise<TaskRecord[]> {
    return this.selectTasks(
      and(eq(schema.tasks.assigneeId, userId), inArray(schema.tasks.status, ['todo', 'doing'])) as SQL,
    )
  }

  async findTaskByMessage(waMessageId: string): Promise<TaskRecord | null> {
    const [task] = await this.selectTasks(eq(schema.tasks.waMessageId, waMessageId))
    if (task) return task
    const notice = await this.findMessage(waMessageId)
    if (notice?.subjectType !== 'task' || !notice.subjectId) return null
    return this.getTask(notice.subjectId)
  }

  async createTask(input: NewTask): Promise<TaskRecord> {
    const kind = input.kind ?? 'todo'
    const subjectType = input.subjectType ?? null
    const subjectId = input.subjectId ?? null
    const inserted = await this.db
      .insert(schema.tasks)
      .values({
        id: newId('tsk'),
        title: input.title.trim(),
        category: input.category,
        status: 'todo',
        kind,
        assigneeId: input.assigneeId,
        assigneeRole: input.assigneeRole ?? null,
        description: input.description ?? null,
        dueAt: input.dueAt ?? null,
        subjectType,
        subjectId,
        createdVia: input.createdVia ?? 'dashboard',
        createdBy: input.createdBy,
      })
      .onConflictDoNothing({
        target: [schema.tasks.subjectType, schema.tasks.subjectId, schema.tasks.kind],
        where: liveSubject,
      })
      .returning({ id: schema.tasks.id })
    const created = inserted[0]
      ? await this.getTask(inserted[0].id)
      : await this.findLiveSubjectTask(subjectType, subjectId, kind)
    if (!created) throw new Error('Task was not saved')
    return created
  }

  private async findLiveSubjectTask(
    subjectType: string | null,
    subjectId: string | null,
    kind: string,
  ): Promise<TaskRecord | null> {
    if (!subjectType || !subjectId) return null
    const [task] = await this.selectTasks(
      and(
        eq(schema.tasks.subjectType, subjectType),
        eq(schema.tasks.subjectId, subjectId),
        eq(schema.tasks.kind, kind),
        ne(schema.tasks.status, 'cancelled'),
      ) as SQL,
    )
    return task ?? null
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<TaskRecord | null> {
    const updated = await this.db
      .update(schema.tasks)
      .set({
        status,
        completedAt: status === 'done' ? sql`coalesce(${schema.tasks.completedAt}, now())` : null,
      })
      .where(eq(schema.tasks.id, id))
      .returning({ id: schema.tasks.id })
    if (updated.length === 0) return null
    return this.getTask(id)
  }

  async updateTaskAssignment(
    id: string,
    assignment: { assigneeId: string | null; assigneeRole: Role | null },
  ): Promise<TaskRecord | null> {
    const changed = sql`${schema.tasks.assigneeId} is distinct from ${assignment.assigneeId}`
    const updated = await this.db
      .update(schema.tasks)
      .set({
        assigneeId: assignment.assigneeId,
        assigneeRole: assignment.assigneeRole,
        notifiedAt: sql`case when ${changed} then null else ${schema.tasks.notifiedAt} end`,
        waMessageId: sql`case when ${changed} then null else ${schema.tasks.waMessageId} end`,
      })
      .where(eq(schema.tasks.id, id))
      .returning({ id: schema.tasks.id })
    if (updated.length === 0) return null
    return this.getTask(id)
  }

  async markTaskNotified(id: string, waMessageId: string | null, at: Date): Promise<void> {
    await this.db.update(schema.tasks).set({ notifiedAt: at, waMessageId }).where(eq(schema.tasks.id, id))
  }

  async enqueueJob(job: NewJob): Promise<JobRecord | null> {
    const [row] = await this.db
      .insert(schema.jobs)
      .values({
        id: newId('job'),
        kind: job.kind,
        payload: job.payload,
        runAfter: job.runAfter ?? new Date(),
        idempotencyKey: job.idempotencyKey ?? null,
        maxAttempts: job.maxAttempts ?? 5,
      })
      .onConflictDoNothing({ target: schema.jobs.idempotencyKey })
      .returning()
    return row ? toJob(row) : null
  }

  async claimJobs(limit: number, leaseMs: number, now: Date): Promise<JobRecord[]> {
    if (limit <= 0) return []
    const ready = this.db.$with('ready').as(
      this.db
        .select({ id: schema.jobs.id })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.status, 'queued'), lte(schema.jobs.runAfter, now)))
        .orderBy(asc(schema.jobs.runAfter), asc(schema.jobs.createdAt))
        .limit(limit)
        .for('update', { skipLocked: true }),
    )
    const rows = await this.db
      .with(ready)
      .update(schema.jobs)
      .set({
        status: 'running',
        attempts: sql`${schema.jobs.attempts} + 1`,
        lockedUntil: new Date(now.getTime() + leaseMs),
        updatedAt: now,
      })
      .where(inArray(schema.jobs.id, this.db.select({ id: ready.id }).from(ready)))
      .returning()
    return rows
      .map(toJob)
      .sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.id.localeCompare(b.id))
  }

  async completeJob(id: string): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({ status: 'done', lockedUntil: null, updatedAt: new Date() })
      .where(eq(schema.jobs.id, id))
  }

  async failJob(id: string, error: string, retryAt: Date | null): Promise<void> {
    await this.db
      .update(schema.jobs)
      .set({
        status: retryAt ? 'queued' : 'failed',
        ...(retryAt ? { runAfter: retryAt } : {}),
        lockedUntil: null,
        lastError: error,
        updatedAt: new Date(),
      })
      .where(eq(schema.jobs.id, id))
  }

  async requeueExpiredJobs(now: Date): Promise<number> {
    const exhausted = sql`${schema.jobs.attempts} >= ${schema.jobs.maxAttempts}`
    const rows = await this.db
      .update(schema.jobs)
      .set({
        status: sql`case when ${exhausted} then 'failed' else 'queued' end`,
        lastError: sql`case when ${exhausted} then 'Lease expired' else ${schema.jobs.lastError} end`,
        lockedUntil: null,
        updatedAt: now,
      })
      .where(and(eq(schema.jobs.status, 'running'), lt(schema.jobs.lockedUntil, now)))
      .returning({ status: schema.jobs.status })
    return rows.filter((row) => row.status === 'queued').length
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const [row] = await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1)
    return row ? toJob(row) : null
  }
}

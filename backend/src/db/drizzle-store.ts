import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'
import type { RecentMessage, Store, ThreadMessage } from './store'
import type {
  AccountLink,
  Balance,
  ClaimedMessage,
  Customer,
  Item,
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
  User,
  WhatsappConnection,
  WhatsappStatus,
} from './types'
import { asItemKind, orderSourceForThread, toPublicUser } from './types'

type Database = PostgresJsDatabase<typeof schema>

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

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
    return { ...row, role: row.role as Role }
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
    return row ? toPublicUser({ ...row, role: row.role as Role }) : null
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
      role: user.role as Role,
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
      })
      .onConflictDoNothing({ target: schema.whatsappMessages.evolutionMessageId })
      .returning({ id: schema.whatsappMessages.id })
    return inserted.length > 0
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
}

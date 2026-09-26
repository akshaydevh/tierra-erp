import { randomUUID } from 'node:crypto'
import { and, desc, eq, gt } from 'drizzle-orm'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { availableQuantity, StockShortError } from '../domain/inventory'
import * as schema from './schema'
import { availabilitySql } from './schema'
import type { Store } from './store'
import type {
  Balance,
  ClaimedMessage,
  Customer,
  Item,
  OrderLineRecord,
  OrderRecord,
  PublicUser,
  Role,
  StoredDocument,
  User,
  WhatsappConnection,
  WhatsappStatus,
} from './types'
import { toPublicUser } from './types'

type Database = PostgresJsDatabase<typeof schema>

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[]
  if (result && typeof result === 'object' && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows
    if (Array.isArray(rows)) return rows as T[]
  }
  return []
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value)
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

  async listCustomers(): Promise<Customer[]> {
    return this.db.select().from(schema.customers).orderBy(schema.customers.name)
  }

  async listItems(): Promise<Item[]> {
    return this.db.select().from(schema.items).orderBy(schema.items.sku)
  }

  async listBalances(): Promise<Balance[]> {
    const rows = await this.db.select().from(schema.inventoryBalances)
    return rows.map((row) => ({ itemId: row.itemId, onHand: row.onHand }))
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

  async createOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    lines: import('./types').NewOrderLine[]
    document: StoredDocument & { messageId: string }
  }): Promise<{ id: string }> {
    return this.db.transaction(async (tx) => {
      const stock = rowsOf<{ item_id: string; on_hand: number; reserved: number }>(
        await tx.execute(availabilitySql),
      )
      const items = await tx.select().from(schema.items)
      const shortages = []
      for (const line of input.lines) {
        const row = stock.find((entry) => entry.item_id === line.itemId)
        const available = availableQuantity(asNumber(row?.on_hand ?? 0), asNumber(row?.reserved ?? 0))
        if (line.quantity > available) {
          const item = items.find((entry) => entry.id === line.itemId)
          shortages.push({
            sku: item?.sku ?? line.itemId,
            name: item?.name ?? line.description,
            requested: line.quantity,
            available,
          })
        }
      }
      if (shortages.length > 0) throw new StockShortError(shortages)

      const id = newId('ord')
      await tx.insert(schema.orders).values({
        id,
        customerId: input.customerId,
        poNumber: input.poNumber,
        poDate: input.poDate,
        status: 'open',
        source: 'whatsapp',
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
      return { id }
    })
  }
}

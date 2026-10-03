import { randomUUID } from 'node:crypto'
import { seedBalances, seedCustomers, seedItems, seedMaterialItems, seedOrders, seedUsers } from './seed-data'
import type { RecentMessage, Store } from './store'
import type {
  AccountLink,
  Balance,
  ClaimedMessage,
  Customer,
  Item,
  NewOrderLine,
  OrderLineRecord,
  OrderRecord,
  OrderSource,
  OrderStatus,
  ProcurementOrderRecord,
  ProductionEntryRecord,
  ProductionPlan,
  PublicUser,
  Role,
  StoredDocument,
  User,
  WhatsappConnection,
} from './types'
import { toPublicUser } from './types'

type SessionRow = { tokenHash: string; userId: string; expiresAt: Date }
type DocumentRow = StoredDocument & { id: string; orderId: string | null; messageId: string | null }

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export class MemoryStore implements Store {
  users: User[]
  sessions: SessionRow[] = []
  customers: Customer[]
  items: Item[]
  balances: Balance[]
  orders: OrderRecord[]
  lines: OrderLineRecord[]
  production: ProductionEntryRecord[] = []
  procurement: ProcurementOrderRecord[] = []
  documents: DocumentRow[] = []
  messages: ClaimedMessage[] = []
  relations: Array<{ userId: string; phoneNumber: string }> = []
  whatsapp: WhatsappConnection = {
    instanceName: 'tierra',
    status: 'disconnected',
    qrBase64: null,
    phoneNumber: null,
  }

  constructor(passwordHash: string) {
    this.users = seedUsers.map((user) => ({ ...user, passwordHash, role: user.role satisfies Role }))
    this.customers = seedCustomers.map((row) => ({ ...row }))
    this.items = [...seedItems, ...seedMaterialItems].map((row) => ({ ...row }))
    this.balances = seedBalances.map((row) => ({ ...row }))
    this.orders = []
    this.lines = []
    for (const order of seedOrders) {
      const customer = seedCustomers.find((row) => row.id === order.customerId)
      this.orders.push({
        id: order.id,
        customerId: order.customerId,
        customerName: customer?.name ?? '',
        poNumber: order.poNumber,
        poDate: order.poDate,
        status: order.status,
        source: order.source,
        createdAt: order.createdAt,
      })
      for (const line of order.lines) {
        const item = seedItems.find((row) => row.id === line.itemId)
        this.lines.push({
          id: line.id,
          orderId: order.id,
          itemId: line.itemId,
          sku: item?.sku ?? '',
          itemName: item?.name ?? '',
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
        })
      }
    }
  }

  async findUserByEmail(email: string): Promise<User | null> {
    return this.users.find((user) => user.email.toLowerCase() === email.toLowerCase()) ?? null
  }

  async createSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void> {
    this.sessions.push(input)
  }

  async findUserByTokenHash(tokenHash: string, now: Date): Promise<PublicUser | null> {
    const session = this.sessions.find((row) => row.tokenHash === tokenHash && row.expiresAt > now)
    if (!session) return null
    const user = this.users.find((row) => row.id === session.userId)
    return user ? toPublicUser(user) : null
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions = this.sessions.filter((row) => row.tokenHash !== tokenHash)
  }

  async listAccountLinks(): Promise<AccountLink[]> {
    return this.users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      phoneNumber: this.relations.find((row) => row.userId === user.id)?.phoneNumber ?? null,
    }))
  }

  async saveRelation(input: { userId: string; phoneNumber: string }): Promise<void> {
    this.relations = this.relations.filter((row) => row.userId !== input.userId)
    this.relations.push({ userId: input.userId, phoneNumber: input.phoneNumber })
  }

  async deleteRelation(userId: string): Promise<void> {
    this.relations = this.relations.filter((row) => row.userId !== userId)
  }

  async listCustomers(): Promise<Customer[]> {
    return this.customers.map((row) => ({ ...row }))
  }

  async listItems(): Promise<Item[]> {
    return this.items.map((row) => ({ ...row }))
  }

  async listBalances(): Promise<Balance[]> {
    return this.balances.map((row) => ({ ...row }))
  }

  async listOrders(): Promise<OrderRecord[]> {
    return [...this.orders].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async listOrderLines(): Promise<OrderLineRecord[]> {
    return this.lines.map((row) => ({ ...row }))
  }

  async orderHasDocument(orderId: string): Promise<boolean> {
    return this.documents.some((row) => row.orderId === orderId)
  }

  async getOrderDocument(orderId: string): Promise<StoredDocument | null> {
    const doc = this.documents.find((row) => row.orderId === orderId)
    if (!doc) return null
    return { filename: doc.filename, mimeType: doc.mimeType, content: doc.content }
  }

  async getWhatsapp(): Promise<WhatsappConnection> {
    return { ...this.whatsapp }
  }

  async saveWhatsapp(
    patch: Partial<Pick<WhatsappConnection, 'status' | 'qrBase64' | 'phoneNumber'>>,
  ): Promise<WhatsappConnection> {
    this.whatsapp = { ...this.whatsapp, ...patch }
    return { ...this.whatsapp }
  }

  async claimMessage(message: ClaimedMessage): Promise<boolean> {
    if (this.messages.some((row) => row.evolutionMessageId === message.evolutionMessageId)) {
      return false
    }
    this.messages.push({ ...message })
    return true
  }

  async listRecentMessages(remoteJids: string[], limit: number): Promise<RecentMessage[]> {
    const jids = new Set(remoteJids)
    return this.messages
      .filter((row) => jids.has(row.remoteJid))
      .slice(-limit)
      .map((row) => ({ remoteJid: row.remoteJid, fromMe: row.fromMe, body: row.body }))
  }

  async releaseMessage(evolutionMessageId: string): Promise<void> {
    this.messages = this.messages.filter((row) => row.evolutionMessageId !== evolutionMessageId)
  }

  async insertDocument(input: StoredDocument & { messageId: string }): Promise<string> {
    const id = newId('doc')
    this.documents.push({ ...input, id, orderId: null, messageId: input.messageId })
    return id
  }

  async listProductionEntries(): Promise<ProductionEntryRecord[]> {
    return this.production.map((entry) => ({ ...entry }))
  }

  async listProcurementOrders(): Promise<ProcurementOrderRecord[]> {
    return this.procurement.map((order) => ({ ...order }))
  }

  async createOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    lines: NewOrderLine[]
    document: StoredDocument & { messageId: string }
    production: ProductionPlan | null
  }): Promise<{ id: string; productionEntryId: string | null; procurementOrderId: string | null }> {
    const id = newId('ord')
    const customer = this.customers.find((row) => row.id === input.customerId)
    const createdAt = new Date().toISOString()
    this.orders.push({
      id,
      customerId: input.customerId,
      customerName: customer?.name ?? '',
      poNumber: input.poNumber,
      poDate: input.poDate,
      status: 'open' satisfies OrderStatus,
      source: 'whatsapp' satisfies OrderSource,
      createdAt,
    })
    for (const line of input.lines) {
      const item = this.items.find((row) => row.id === line.itemId)
      this.lines.push({
        id: newId('lin'),
        orderId: id,
        itemId: line.itemId,
        sku: item?.sku ?? '',
        itemName: item?.name ?? '',
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
      })
    }
    this.documents.push({
      ...input.document,
      id: newId('doc'),
      orderId: id,
      messageId: input.document.messageId,
    })
    if (!input.production) return { id, productionEntryId: null, procurementOrderId: null }
    const productionEntryId = newId('prd')
    const procurementOrderId = newId('prc')
    const item = this.items.find((row) => row.id === input.production?.rawItemId)
    const assignee = this.users.find((row) => row.id === input.production?.assigneeId)
    this.production.push({
      id: productionEntryId,
      orderId: id,
      poNumber: input.poNumber,
      customerName: customer?.name ?? '',
      finishedGoodsKg: input.production.finishedGoodsKg,
      kgBananaPerKgChips: input.production.kgBananaPerKgChips,
      bananaKg: input.production.bananaKg,
      sourceMonths: input.production.sourceMonths,
      createdAt,
    })
    this.procurement.push({
      id: procurementOrderId,
      orderId: id,
      poNumber: input.poNumber,
      customerName: customer?.name ?? '',
      productionEntryId,
      itemName: item?.name ?? 'Raw banana',
      quantityKg: input.production.bananaKg,
      unit: 'kg',
      assigneeId: input.production.assigneeId,
      assigneeName: assignee?.name ?? 'Joshy',
      createdAt,
    })
    return { id, productionEntryId, procurementOrderId }
  }
}

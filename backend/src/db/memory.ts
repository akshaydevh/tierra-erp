import { randomUUID } from 'node:crypto'
import { seedBalances, seedCustomers, seedItems, seedMaterialItems, seedOrders, seedUsers } from './seed-data'
import type { RecentMessage, Store, ThreadMessage } from './store'
import type {
  AccountLink,
  Balance,
  ChatContext,
  ClaimedMessage,
  Customer,
  Item,
  JobRecord,
  NewJob,
  NewTask,
  NewOrderLine,
  OrderLineRecord,
  OrderRecord,
  OrderStatus,
  PendingConfirmation,
  ProcurementOrderRecord,
  ProductionEntryRecord,
  ProductionPlan,
  PublicUser,
  Role,
  StoredDocument,
  StoredMessage,
  TaskRecord,
  TaskStatus,
  User,
  WhatsappConnection,
} from './types'
import { orderSourceForThread, toPublicUser } from './types'

type SessionRow = { tokenHash: string; userId: string; expiresAt: Date }
type JobRow = JobRecord & { seq: number; updatedAt: string }
type MessageRow = ClaimedMessage & { createdAt: string }
type DocumentRow = StoredDocument & { id: string; orderId: string | null; messageId: string | null }
type StoredProcurement = ProcurementOrderRecord & { pendingOrderId: string | null }
type PendingRow = {
  id: string
  customerId: string
  poNumber: string
  poDate: string | null
  remoteJid: string
  documentId: string
  status: 'awaiting_admin' | 'confirmed' | 'declined'
  lines: NewOrderLine[]
  createdAt: string
}

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
  procurement: StoredProcurement[] = []
  pending: PendingRow[] = []
  documents: DocumentRow[] = []
  messages: MessageRow[] = []
  tasks: TaskRecord[] = []
  relations: Array<{ userId: string; phoneNumber: string }> = []
  identities = new Map<string, string>()
  chatContexts = new Map<string, ChatContext>()
  jobs: JobRow[] = []
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

  async updateUserRole(userId: string, role: Role): Promise<'ok' | 'not_found' | 'admin_taken'> {
    const user = this.users.find((row) => row.id === userId)
    if (!user) return 'not_found'
    if (role === 'admin' && this.users.some((row) => row.role === 'admin' && row.id !== userId)) return 'admin_taken'
    user.role = role
    return 'ok'
  }

  async transferAdmin(userId: string): Promise<'ok' | 'not_found'> {
    const user = this.users.find((row) => row.id === userId)
    if (!user) return 'not_found'
    for (const row of this.users) {
      if (row.role === 'admin' && row.id !== userId) row.role = 'manager'
    }
    user.role = 'admin'
    return 'ok'
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
    if (message.idempotencyKey && this.messages.some((row) => row.idempotencyKey === message.idempotencyKey)) {
      throw new Error(`Duplicate message idempotency key ${message.idempotencyKey}`)
    }
    this.messages.push({ ...message, createdAt: new Date().toISOString() })
    return true
  }

  async findMessage(evolutionMessageId: string): Promise<StoredMessage | null> {
    const row = this.messages.find((message) => message.evolutionMessageId === evolutionMessageId)
    if (!row) return null
    return {
      evolutionMessageId: row.evolutionMessageId,
      remoteJid: row.remoteJid,
      fromMe: row.fromMe,
      body: row.body,
      kind: row.kind ?? 'text',
      purpose: row.purpose ?? null,
      subjectType: row.subjectType ?? null,
      subjectId: row.subjectId ?? null,
      createdAt: row.createdAt,
    }
  }

  async saveIdentity(lid: string, phone: string): Promise<void> {
    this.identities.set(lid, phone)
  }

  async phoneForLid(lid: string): Promise<string | null> {
    return this.identities.get(lid) ?? null
  }

  async getChatContext(chatJid: string): Promise<ChatContext | null> {
    const context = this.chatContexts.get(chatJid)
    return context ? { ...context } : null
  }

  async setChatContext(chatJid: string, subjectType: string, subjectId: string): Promise<void> {
    this.chatContexts.set(chatJid, { chatJid, subjectType, subjectId, updatedAt: new Date().toISOString() })
  }

  async listRecentMessages(remoteJids: string[], limit: number): Promise<RecentMessage[]> {
    const jids = new Set(remoteJids)
    return this.messages
      .filter((row) => jids.has(row.remoteJid))
      .slice(-limit)
      .map((row) => ({ remoteJid: row.remoteJid, fromMe: row.fromMe, body: row.body }))
  }

  async listThread(remoteJid: string): Promise<ThreadMessage[]> {
    return this.messages
      .filter((row) => row.remoteJid === remoteJid)
      .map((row) => ({
        id: row.evolutionMessageId,
        fromMe: row.fromMe,
        hasPdf: row.hasPdf,
        body: row.body,
        filename: this.documents.find((doc) => doc.messageId === row.evolutionMessageId)?.filename ?? null,
        createdAt: row.createdAt,
      }))
  }

  async releaseMessage(evolutionMessageId: string): Promise<void> {
    this.messages = this.messages.filter((row) => row.evolutionMessageId !== evolutionMessageId)
  }

  async hasDocumentForMessage(messageId: string): Promise<boolean> {
    return this.documents.some((row) => row.messageId === messageId)
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
    return this.procurement.map(({ pendingOrderId: _pendingOrderId, ...order }) => ({ ...order }))
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
    const createdAt = new Date().toISOString()
    const customer = this.customers.find((row) => row.id === input.customerId)
    const assignee = this.users.find((row) => row.id === input.assigneeId)
    this.pending.push({
      id,
      customerId: input.customerId,
      poNumber: input.poNumber,
      poDate: input.poDate,
      remoteJid: input.remoteJid,
      documentId: input.documentId,
      status: 'awaiting_admin',
      lines: input.lines.map((line) => ({ ...line })),
      createdAt,
    })
    for (const shortage of input.shortages) {
      const item = this.items.find((row) => row.id === shortage.itemId)
      this.procurement.push({
        id: newId('prc'),
        orderId: null,
        pendingOrderId: id,
        poNumber: input.poNumber,
        customerName: customer?.name ?? '',
        productionEntryId: null,
        itemName: item?.name ?? shortage.itemId,
        quantityKg: String(shortage.quantity),
        unit: shortage.unit,
        assigneeId: input.assigneeId,
        assigneeName: assignee?.name ?? '',
        createdAt,
      })
    }
    return { id }
  }

  async listAwaitingConfirmations(remoteJid: string): Promise<PendingConfirmation[]> {
    return [...this.pending]
      .reverse()
      .filter((row) => row.remoteJid === remoteJid && row.status === 'awaiting_admin')
      .map((row) => ({ id: row.id, poNumber: row.poNumber, lines: row.lines.map((line) => ({ ...line })) }))
  }

  async confirmPendingOrder(
    id: string,
    production: ProductionPlan | null,
  ): Promise<{ id: string; poNumber: string; productionEntryId: string | null; procurementOrderId: string | null } | null> {
    const pending = this.pending.find((row) => row.id === id && row.status === 'awaiting_admin')
    if (!pending) return null
    const orderId = newId('ord')
    const createdAt = new Date().toISOString()
    const customer = this.customers.find((row) => row.id === pending.customerId)
    this.orders.push({
      id: orderId,
      customerId: pending.customerId,
      customerName: customer?.name ?? '',
      poNumber: pending.poNumber,
      poDate: pending.poDate,
      status: 'open',
      source: orderSourceForThread(pending.remoteJid),
      createdAt,
    })
    for (const line of pending.lines) {
      const item = this.items.find((row) => row.id === line.itemId)
      this.lines.push({
        id: newId('lin'),
        orderId,
        itemId: line.itemId,
        sku: item?.sku ?? '',
        itemName: item?.name ?? '',
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
      })
    }
    const document = this.documents.find((row) => row.id === pending.documentId)
    if (document) document.orderId = orderId
    for (const row of this.procurement) {
      if (row.pendingOrderId === pending.id) row.orderId = orderId
    }
    pending.status = 'confirmed'
    if (!production) return { id: orderId, poNumber: pending.poNumber, productionEntryId: null, procurementOrderId: null }
    const productionEntryId = newId('prd')
    const procurementOrderId = newId('prc')
    const item = this.items.find((row) => row.id === production.rawItemId)
    const assignee = this.users.find((row) => row.id === production.assigneeId)
    this.production.push({
      id: productionEntryId,
      orderId,
      poNumber: pending.poNumber,
      customerName: customer?.name ?? '',
      finishedGoodsKg: production.finishedGoodsKg,
      kgBananaPerKgChips: production.kgBananaPerKgChips,
      bananaKg: production.bananaKg,
      sourceMonths: production.sourceMonths,
      createdAt,
    })
    this.procurement.push({
      id: procurementOrderId,
      orderId,
      pendingOrderId: null,
      poNumber: pending.poNumber,
      customerName: customer?.name ?? '',
      productionEntryId,
      itemName: item?.name ?? 'Raw banana',
      quantityKg: production.bananaKg,
      unit: 'kg',
      assigneeId: production.assigneeId,
      assigneeName: assignee?.name ?? '',
      createdAt,
    })
    return { id: orderId, poNumber: pending.poNumber, productionEntryId, procurementOrderId }
  }

  async declinePendingOrder(id: string): Promise<{ poNumber: string } | null> {
    const pending = this.pending.find((row) => row.id === id && row.status === 'awaiting_admin')
    if (!pending) return null
    pending.status = 'declined'
    return { poNumber: pending.poNumber }
  }

  async createOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    remoteJid: string
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
      source: orderSourceForThread(input.remoteJid),
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
      pendingOrderId: null,
      poNumber: input.poNumber,
      customerName: customer?.name ?? '',
      productionEntryId,
      itemName: item?.name ?? 'Raw banana',
      quantityKg: input.production.bananaKg,
      unit: 'kg',
      assigneeId: input.production.assigneeId,
      assigneeName: assignee?.name ?? '',
      createdAt,
    })
    return { id, productionEntryId, procurementOrderId }
  }

  private userName(id: string | null): string | null {
    return id ? (this.users.find((user) => user.id === id)?.name ?? null) : null
  }

  private newestFirst(tasks: TaskRecord[]): TaskRecord[] {
    return [...tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async listTasks(): Promise<TaskRecord[]> {
    return this.newestFirst(this.tasks)
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    return this.tasks.find((task) => task.id === id) ?? null
  }

  async listOpenTasksForUser(userId: string): Promise<TaskRecord[]> {
    return this.newestFirst(
      this.tasks.filter((task) => task.assigneeId === userId && (task.status === 'todo' || task.status === 'doing')),
    )
  }

  async listUnnotifiedOpenTasks(): Promise<TaskRecord[]> {
    return this.newestFirst(
      this.tasks.filter(
        (task) =>
          (task.status === 'todo' || task.status === 'doing') &&
          task.assigneeId !== null &&
          task.kind !== 'approval' &&
          task.notifiedAt === null,
      ),
    )
  }

  async findTaskByMessage(waMessageId: string): Promise<TaskRecord | null> {
    const task = this.tasks.find((row) => row.waMessageId === waMessageId)
    if (task) return task
    const notice = await this.findMessage(waMessageId)
    if (notice?.subjectType !== 'task' || !notice.subjectId) return null
    return this.getTask(notice.subjectId)
  }

  async createTask(input: NewTask): Promise<TaskRecord> {
    const kind = input.kind ?? 'todo'
    const subjectType = input.subjectType ?? null
    const subjectId = input.subjectId ?? null
    const existing = subjectType
      ? this.tasks.find(
          (task) =>
            task.subjectType === subjectType &&
            task.subjectId === subjectId &&
            task.kind === kind &&
            task.status !== 'cancelled',
        )
      : undefined
    if (existing) return existing
    const assignee = input.assigneeId ? this.users.find((user) => user.id === input.assigneeId) : undefined
    const createdAt = new Date().toISOString()
    const task: TaskRecord = {
      id: newId('tsk'),
      title: input.title.trim(),
      category: input.category,
      status: 'todo',
      kind,
      assigneeId: assignee?.id ?? null,
      assigneeName: assignee?.name ?? null,
      assigneeRole: input.assigneeRole ?? null,
      description: input.description ?? null,
      dueAt: input.dueAt?.toISOString() ?? null,
      subjectType,
      subjectId,
      notifiedAt: null,
      waMessageId: null,
      createdVia: input.createdVia ?? 'dashboard',
      createdBy: input.createdBy,
      createdByName: this.userName(input.createdBy),
      createdAt,
      completedAt: null,
      assignedAt: createdAt,
    }
    this.tasks.push(task)
    return task
  }

  async updateTaskStatus(id: string, status: TaskStatus): Promise<TaskRecord | null> {
    const task = this.tasks.find((row) => row.id === id)
    if (!task) return null
    task.status = status
    task.completedAt = status === 'done' ? (task.completedAt ?? new Date().toISOString()) : null
    return task
  }

  async cancelTasksForSubject(subjectType: string, subjectId: string): Promise<number> {
    const open = this.tasks.filter(
      (task) =>
        task.subjectType === subjectType &&
        task.subjectId === subjectId &&
        (task.status === 'todo' || task.status === 'doing'),
    )
    for (const task of open) task.status = 'cancelled'
    return open.length
  }

  async updateTaskAssignment(
    id: string,
    assignment: { assigneeId: string | null; assigneeRole: Role | null },
  ): Promise<TaskRecord | null> {
    const task = this.tasks.find((row) => row.id === id)
    if (!task) return null
    const assignee = assignment.assigneeId ? this.users.find((user) => user.id === assignment.assigneeId) : undefined
    if (assignment.assigneeId && !assignee) return null
    if (task.assigneeId !== (assignee?.id ?? null)) {
      task.notifiedAt = null
      task.waMessageId = null
      task.assignedAt = new Date().toISOString()
    }
    task.assigneeId = assignee?.id ?? null
    task.assigneeName = assignee?.name ?? null
    task.assigneeRole = assignment.assigneeRole
    return task
  }

  async reserveTaskNotice(id: string, assigneeId: string): Promise<boolean> {
    const task = this.tasks.find((row) => row.id === id)
    if (!task || task.assigneeId !== assigneeId || task.notifiedAt) return false
    task.notifiedAt = new Date().toISOString()
    return true
  }

  async releaseTaskNotice(id: string): Promise<void> {
    const task = this.tasks.find((row) => row.id === id)
    if (task && !task.waMessageId) task.notifiedAt = null
  }

  async releaseStaleTaskNotices(before: Date): Promise<number> {
    let released = 0
    for (const task of this.tasks) {
      const stale =
        (task.status === 'todo' || task.status === 'doing') &&
        !task.waMessageId &&
        task.notifiedAt !== null &&
        new Date(task.notifiedAt).getTime() < before.getTime()
      if (!stale) continue
      task.notifiedAt = null
      released += 1
    }
    return released
  }

  async markTaskNotified(id: string, waMessageId: string | null, at: Date): Promise<void> {
    const task = this.tasks.find((row) => row.id === id)
    if (!task) return
    task.notifiedAt = at.toISOString()
    task.waMessageId = waMessageId
  }

  private toJob({ seq: _seq, updatedAt: _updatedAt, ...job }: JobRow): JobRecord {
    return { ...job, payload: { ...job.payload } }
  }

  async enqueueJob(job: NewJob): Promise<JobRecord | null> {
    const key = job.idempotencyKey ?? null
    if (key && this.jobs.some((row) => row.idempotencyKey === key)) return null
    const row: JobRow = {
      id: newId('job'),
      kind: job.kind,
      payload: { ...job.payload },
      status: 'queued',
      attempts: 0,
      maxAttempts: job.maxAttempts ?? 5,
      runAfter: (job.runAfter ?? new Date()).toISOString(),
      lockedUntil: null,
      idempotencyKey: key,
      lastError: null,
      seq: this.jobs.length,
      updatedAt: new Date().toISOString(),
    }
    this.jobs.push(row)
    return this.toJob(row)
  }

  async claimJobs(limit: number, leaseMs: number, now: Date): Promise<JobRecord[]> {
    const lockedUntil = new Date(now.getTime() + leaseMs).toISOString()
    const ready = this.jobs
      .filter((job) => job.status === 'queued' && new Date(job.runAfter) <= now)
      .sort((a, b) => a.runAfter.localeCompare(b.runAfter) || a.seq - b.seq)
      .slice(0, Math.max(0, limit))
    for (const job of ready) {
      job.status = 'running'
      job.attempts += 1
      job.lockedUntil = lockedUntil
      job.updatedAt = now.toISOString()
    }
    return ready.map((job) => this.toJob(job))
  }

  async completeJob(id: string): Promise<void> {
    const job = this.jobs.find((row) => row.id === id)
    if (!job) return
    job.status = 'done'
    job.lockedUntil = null
    job.updatedAt = new Date().toISOString()
  }

  async failJob(id: string, error: string, retryAt: Date | null): Promise<void> {
    const job = this.jobs.find((row) => row.id === id)
    if (!job) return
    job.status = retryAt ? 'queued' : 'failed'
    if (retryAt) job.runAfter = retryAt.toISOString()
    job.lockedUntil = null
    job.lastError = error
    job.updatedAt = new Date().toISOString()
  }

  async requeueExpiredJobs(now: Date): Promise<number> {
    let requeued = 0
    for (const job of this.jobs) {
      if (job.status !== 'running' || !job.lockedUntil || new Date(job.lockedUntil) >= now) continue
      job.lockedUntil = null
      job.updatedAt = now.toISOString()
      if (job.attempts >= job.maxAttempts) {
        job.status = 'failed'
        job.lastError = 'Lease expired'
        continue
      }
      job.status = 'queued'
      requeued += 1
    }
    return requeued
  }

  async pruneJobs(before: Date): Promise<number> {
    const finished = (job: JobRow) =>
      (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') && new Date(job.updatedAt) < before
    const count = this.jobs.filter(finished).length
    this.jobs = this.jobs.filter((job) => !finished(job))
    return count
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const job = this.jobs.find((row) => row.id === id)
    return job ? this.toJob(job) : null
  }
}

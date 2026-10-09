import { randomUUID } from 'node:crypto'
import { seedUsers } from './seed-data'
import {
  CustomerPoRevisionTakenError,
  PartyGroupConflictError,
  normalizeMembers,
  type RecentMessage,
  type Store,
  type ThreadMessage,
  type WaGroupPatch,
} from './store'
import type {
  BankLineReattribution,
  DailyInputsPatch,
  DailyReportInputs,
  DailyReportRecord,
  GlLabel,
  NewDailyReport,
  Approval,
  ApprovalPatch,
  ApprovalStatus,
  DocumentInfo,
  NewApproval,
  NewProcurementRequest,
  NewSalesOrder,
  NewStockAdjustment,
  OutboundRow,
  ProcurementRequest,
  ProcurementStatus,
  SalesOrder,
  SalesOrderPatch,
  SalesOrderStatus,
  StockAdjustment,
  AccountLink,
  ChatContext,
  ClaimedMessage,
  CustomerItemRef,
  CustomerPo,
  CustomerPoLine,
  CustomerPoPatch,
  CustomerPoSummary,
  CustomerSite,
  DocumentLink,
  InventoryCheck,
  ItemOwnerOverride,
  NewCustomerPo,
  NewInventoryCheck,
  PartyAlias,
  StockOverlay,
  JobRecord,
  NewJob,
  NewPartyGroup,
  NewTask,
  PartyGroup,
  PublicUser,
  Role,
  StoredDocument,
  FetchedDocument,
  StoredMessage,
  TaskRecord,
  TaskStatus,
  User,
  WaGroup,
  WhatsappConnection,
} from './types'
import { RESERVING_SO_STATUSES, toPublicUser } from './types'

type SessionRow = { tokenHash: string; userId: string; expiresAt: Date }
type JobRow = JobRecord & { seq: number; updatedAt: string }
type MessageRow = ClaimedMessage & { createdAt: string; answeredAt?: string | null }
type DocumentRow = StoredDocument & {
  id: string
  createdAt: string
  messageId: string | null
  kind: DocumentLink['kind']
  subjectType: string | null
  subjectId: string | null
  version: number
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`
}

export class MemoryStore implements Store {
  users: User[]
  sessions: SessionRow[] = []
  documents: DocumentRow[] = []
  messages: MessageRow[] = []
  tasks: TaskRecord[] = []
  relations: Array<{ userId: string; phoneNumber: string }> = []
  identities = new Map<string, string>()
  chatContexts = new Map<string, ChatContext>()
  jobs: JobRow[] = []
  partyGroups: PartyGroup[] = []
  waGroups: WaGroup[] = []
  customerSites: CustomerSite[] = []
  customerItemRefs: CustomerItemRef[] = []
  itemOwnerOverrides: ItemOwnerOverride[] = []
  partyAliases: PartyAlias[] = []
  customerPos: CustomerPo[] = []
  inventoryChecks: InventoryCheck[] = []
  salesOrders: SalesOrder[] = []
  docCounters = new Map<string, number>()
  approvals: Approval[] = []
  procurementRequests: ProcurementRequest[] = []
  stockAdjustments: StockAdjustment[] = []
  glLabels: GlLabel[] = []
  reattributions: BankLineReattribution[] = []
  dailyInputs = new Map<string, DailyReportInputs>()
  dailyReports: DailyReportRecord[] = []
  settings = new Map<string, unknown>()
  whatsapp: WhatsappConnection = {
    instanceName: 'tierra',
    status: 'disconnected',
    qrBase64: null,
    phoneNumber: null,
  }

  constructor(passwordHash: string) {
    this.users = seedUsers.map((user) => ({ ...user, passwordHash, role: user.role satisfies Role }))
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
      .map((row) => ({
        id: row.evolutionMessageId,
        remoteJid: row.remoteJid,
        fromMe: row.fromMe,
        body: row.body,
        purpose: row.purpose ?? null,
        createdAt: row.createdAt,
      }))
  }

  async markMessageAnswered(evolutionMessageId: string, at: Date): Promise<void> {
    const row = this.messages.find((message) => message.evolutionMessageId === evolutionMessageId)
    if (row && !row.answeredAt) row.answeredAt = at.toISOString()
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
        answeredAt: row.answeredAt ?? null,
      }))
  }

  async releaseMessage(evolutionMessageId: string): Promise<void> {
    this.messages = this.messages.filter((row) => row.evolutionMessageId !== evolutionMessageId)
  }

  async hasDocumentForMessage(messageId: string): Promise<boolean> {
    return this.documents.some((row) => row.messageId === messageId)
  }

  async insertDocument(input: StoredDocument & { messageId?: string | null } & Partial<DocumentLink>): Promise<string> {
    const id = newId('doc')
    this.documents.push({
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
      id,
      messageId: input.messageId ?? null,
      kind: input.kind ?? 'other',
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      version: input.version ?? 1,
      createdAt: new Date(Date.now() + this.documents.length).toISOString(),
    })
    return id
  }

  async linkDocument(id: string, link: DocumentLink): Promise<void> {
    const row = this.documents.find((doc) => doc.id === id)
    if (!row) return
    row.kind = link.kind
    if (link.subjectType !== undefined) row.subjectType = link.subjectType
    if (link.subjectId !== undefined) row.subjectId = link.subjectId
    if (link.version !== undefined) row.version = link.version
  }

  async getDocument(id: string): Promise<FetchedDocument | null> {
    const row = this.documents.find((doc) => doc.id === id)
    return row ? { filename: row.filename, mimeType: row.mimeType, content: row.content, kind: row.kind } : null
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

  async reopenTask(id: string, patch: { title: string; description: string | null }): Promise<TaskRecord | null> {
    const task = this.tasks.find((row) => row.id === id)
    if (!task) return null
    Object.assign(task, {
      title: patch.title.trim(),
      description: patch.description,
      status: 'todo',
      completedAt: null,
      notifiedAt: null,
      waMessageId: null,
      assignedAt: new Date().toISOString(),
    })
    return { ...task }
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

  async listPartyGroups(): Promise<PartyGroup[]> {
    return [...this.partyGroups]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((group) => ({ ...group, members: [...group.members] }))
  }

  async getPartyGroup(id: string): Promise<PartyGroup | null> {
    const group = this.partyGroups.find((row) => row.id === id)
    return group ? { ...group, members: [...group.members] } : null
  }

  private checkPartyGroup(id: string | null, input: NewPartyGroup): PartyGroup {
    const name = input.name.trim()
    if (this.partyGroups.some((group) => group.id !== id && group.name === name)) {
      throw new PartyGroupConflictError(`A party group called ${name} already exists`)
    }
    const members = normalizeMembers(input.members).sort(
      (a, b) => a.kind.localeCompare(b.kind) || a.value.localeCompare(b.value),
    )
    for (const member of members) {
      const owner = this.partyGroups.find(
        (group) => group.id !== id && group.members.some((row) => row.kind === member.kind && row.value === member.value),
      )
      if (owner) throw new PartyGroupConflictError(`${member.value} already belongs to ${owner.name}`)
    }
    return { id: id ?? newId('pty'), name, alias: input.alias?.trim() || null, members }
  }

  async createPartyGroup(input: NewPartyGroup): Promise<PartyGroup> {
    const group = this.checkPartyGroup(null, input)
    this.partyGroups.push(group)
    return { ...group, members: [...group.members] }
  }

  async updatePartyGroup(id: string, input: NewPartyGroup): Promise<PartyGroup | null> {
    const index = this.partyGroups.findIndex((group) => group.id === id)
    if (index < 0) return null
    const group = this.checkPartyGroup(id, input)
    this.partyGroups[index] = group
    return { ...group, members: [...group.members] }
  }

  async deletePartyGroup(id: string): Promise<boolean> {
    const before = this.partyGroups.length
    this.partyGroups = this.partyGroups.filter((group) => group.id !== id)
    for (const row of this.waGroups) if (row.partyGroupId === id) row.partyGroupId = null
    return this.partyGroups.length < before
  }

  async getWaGroup(jid: string): Promise<WaGroup | null> {
    const row = this.waGroups.find((group) => group.jid === jid)
    return row ? { ...row } : null
  }

  async listWaGroups(): Promise<WaGroup[]> {
    return this.waGroups.map((row) => ({ ...row }))
  }

  async saveWaGroup(jid: string, patch: WaGroupPatch): Promise<WaGroup> {
    let row = this.waGroups.find((group) => group.jid === jid)
    if (!row) {
      row = { jid, subject: null, partyGroupId: null, sendSo: true, updatedAt: new Date().toISOString() }
      this.waGroups.push(row)
    }
    if (patch.subject !== undefined) row.subject = patch.subject
    if (patch.partyGroupId !== undefined) row.partyGroupId = patch.partyGroupId
    if (patch.sendSo !== undefined) row.sendSo = patch.sendSo
    row.updatedAt = new Date().toISOString()
    return { ...row }
  }

  async listCustomerSites(): Promise<CustomerSite[]> {
    return this.customerSites.map((row) => ({ ...row }))
  }

  async listCustomerItemRefs(partyGroupId?: string): Promise<CustomerItemRef[]> {
    return this.customerItemRefs.filter((row) => !partyGroupId || row.partyGroupId === partyGroupId).map((row) => ({ ...row }))
  }

  async listItemOwnerOverrides(): Promise<ItemOwnerOverride[]> {
    return this.itemOwnerOverrides.map((row) => ({ ...row }))
  }

  async listPartyAliases(): Promise<PartyAlias[]> {
    return this.partyAliases.map((row) => ({ ...row }))
  }

  private copyPo(po: CustomerPo): CustomerPo {
    const partyName = po.partyGroupId ? (this.partyGroups.find((group) => group.id === po.partyGroupId)?.name ?? null) : null
    return { ...po, partyName, lines: po.lines.map((line) => ({ ...line })), repeatOf: [...po.repeatOf], notes: [...po.notes] }
  }

  async createCustomerPo(input: NewCustomerPo): Promise<CustomerPo> {
    const revision = input.revision ?? 1
    const live = this.customerPos.find(
      (row) =>
        row.status !== 'cancelled' &&
        input.partyGroupId !== null &&
        row.partyGroupId === input.partyGroupId &&
        row.poNo === input.poNo &&
        row.revision === revision,
    )
    if (live) throw new CustomerPoRevisionTakenError(input.poNo, revision)
    if (input.sourceMessageId && this.customerPos.some((row) => row.sourceMessageId === input.sourceMessageId)) {
      throw new Error(`A PO from message ${input.sourceMessageId} is already recorded`)
    }
    const at = new Date(Date.now() + this.customerPos.length).toISOString()
    const { revision: _revision, ...rest } = input
    const po: CustomerPo = { ...rest, id: newId('cpo'), revision, partyName: null, createdAt: at, updatedAt: at }
    this.customerPos.push(po)
    return this.copyPo(po)
  }

  async getCustomerPo(id: string): Promise<CustomerPo | null> {
    const po = this.customerPos.find((row) => row.id === id)
    return po ? this.copyPo(po) : null
  }

  async findCustomerPoByMessage(messageId: string): Promise<CustomerPo | null> {
    const po = this.customerPos.find((row) => row.sourceMessageId === messageId)
    return po ? this.copyPo(po) : null
  }

  async findCustomerPosByNumber(poNo: string): Promise<CustomerPo[]> {
    return this.customerPos
      .filter((row) => row.poNo === poNo && row.status !== 'cancelled')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((row) => this.copyPo(row))
  }

  async listCustomerPos(filter: { limit?: number; status?: string | null } = {}): Promise<CustomerPoSummary[]> {
    return [...this.customerPos]
      .filter((row) => !filter.status || row.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, filter.limit ?? 100)
      .map((row) => {
        const po = this.copyPo(row)
        const check = this.inventoryChecks
          .filter((entry) => entry.customerPoId === row.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
        return {
          id: po.id,
          poNo: po.poNo,
          revision: po.revision,
          status: po.status,
          partyGroupId: po.partyGroupId,
          partyName: po.partyName,
          cardCode: po.cardCode,
          siteCode: po.siteCode,
          poDate: po.poDate,
          deliveryDate: po.deliveryDate,
          total: po.total,
          lineCount: po.lines.length,
          verdict: check?.verdict ?? null,
          repeat: po.repeatOf.length > 0,
          reviewReason: po.reviewReason,
          sourceChat: po.sourceChat,
          createdAt: po.createdAt,
        }
      })
  }

  async updateCustomerPo(id: string, patch: CustomerPoPatch): Promise<CustomerPo | null> {
    const po = this.customerPos.find((row) => row.id === id)
    if (!po) return null
    Object.assign(po, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)))
    po.updatedAt = new Date().toISOString()
    return this.copyPo(po)
  }

  async updateCustomerPoLines(id: string, lines: CustomerPoLine[]): Promise<CustomerPo | null> {
    const po = this.customerPos.find((row) => row.id === id)
    if (!po) return null
    po.lines = lines.map((line) => ({ ...line }))
    po.updatedAt = new Date().toISOString()
    return this.copyPo(po)
  }

  async saveInventoryCheck(input: NewInventoryCheck): Promise<InventoryCheck> {
    const check: InventoryCheck = {
      ...input,
      lines: input.lines.map((line) => ({ ...line })),
      id: newId('chk'),
      createdAt: new Date(Date.now() + this.inventoryChecks.length).toISOString(),
    }
    this.inventoryChecks.push(check)
    return { ...check, lines: check.lines.map((line) => ({ ...line })) }
  }

  async getInventoryCheck(id: string): Promise<InventoryCheck | null> {
    const check = this.inventoryChecks.find((row) => row.id === id)
    return check ? { ...check, lines: check.lines.map((line) => ({ ...line })) } : null
  }

  async latestInventoryCheck(customerPoId: string): Promise<InventoryCheck | null> {
    const check = this.inventoryChecks
      .filter((row) => row.customerPoId === customerPoId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    return check ? { ...check, lines: check.lines.map((line) => ({ ...line })) } : null
  }

  async stockOverlays(itemCodes: readonly string[]): Promise<Record<string, StockOverlay>> {
    const wanted = new Set(itemCodes)
    const out: Record<string, StockOverlay> = {}
    const entry = (code: string) => (out[code] ??= { reserved: 0, adjustments: 0 })
    for (const order of this.salesOrders.filter((row) => RESERVING_SO_STATUSES.includes(row.status))) {
      for (const line of order.lines) if (wanted.has(line.itemCode)) entry(line.itemCode).reserved += line.reservedPcs
      const check = order.checkId ? this.inventoryChecks.find((row) => row.id === order.checkId) : undefined
      for (const line of check?.lines ?? []) {
        if (line.kind === 'component' && wanted.has(line.itemCode)) entry(line.itemCode).reserved += line.need
      }
    }
    for (const adjustment of this.stockAdjustments) {
      if (adjustment.status === 'active' && wanted.has(adjustment.itemCode)) entry(adjustment.itemCode).adjustments += adjustment.qty
    }
    return out
  }

  // ------------------------------------------------------------------------------------------ P4: sales orders

  private copySo(order: SalesOrder): SalesOrder {
    const partyName = order.partyGroupId ? (this.partyGroups.find((group) => group.id === order.partyGroupId)?.name ?? null) : null
    return { ...order, partyName, notes: [...order.notes], lines: order.lines.map((line) => ({ ...line })) }
  }

  async createSalesOrder(
    input: NewSalesOrder,
    numbering: { series: string; fy: string },
  ): Promise<{ order: SalesOrder; created: boolean }> {
    const live = input.customerPoId ? await this.findSalesOrderForPo(input.customerPoId) : null
    if (live) return { order: live, created: false }
    const key = `${numbering.series}|${numbering.fy}`
    const seq = this.docCounters.get(key) ?? 1
    this.docCounters.set(key, seq + 1)
    const at = new Date(Date.now() + this.salesOrders.length).toISOString()
    const order: SalesOrder = {
      ...input,
      cess: input.cess ?? 0,
      lines: input.lines.map((line) => ({ ...line, cessAmount: line.cessAmount ?? 0 })),
      notes: [...input.notes],
      id: newId('tso'),
      docNo: `${numbering.series}/${numbering.fy}/${String(seq).padStart(4, '0')}`,
      series: numbering.series,
      fy: numbering.fy,
      seq,
      version: 1,
      approvedBy: null,
      approvedAt: null,
      sentAt: null,
      sapDocEntry: null,
      sapDocNo: null,
      cancelledAt: null,
      partyName: null,
      createdAt: at,
      updatedAt: at,
    }
    this.salesOrders.push(order)
    return { order: this.copySo(order), created: true }
  }

  async getSalesOrder(id: string): Promise<SalesOrder | null> {
    const order = this.salesOrders.find((row) => row.id === id)
    return order ? this.copySo(order) : null
  }

  async findSalesOrderByNo(docNo: string): Promise<SalesOrder | null> {
    const order = this.salesOrders.find((row) => row.docNo === docNo.toUpperCase())
    return order ? this.copySo(order) : null
  }

  async findSalesOrderForPo(customerPoId: string): Promise<SalesOrder | null> {
    const order = this.salesOrders.find(
      (row) => row.customerPoId === customerPoId && row.status !== 'cancelled' && row.status !== 'rejected',
    )
    return order ? this.copySo(order) : null
  }

  async listSalesOrders(filter: { status?: SalesOrderStatus | null; limit?: number } = {}): Promise<SalesOrder[]> {
    return [...this.salesOrders]
      .filter((row) => !filter.status || row.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 200)
      .map((row) => this.copySo(row))
  }

  async updateSalesOrder(id: string, patch: SalesOrderPatch, from?: readonly SalesOrderStatus[]): Promise<SalesOrder | null> {
    const order = this.salesOrders.find((row) => row.id === id)
    if (!order || (from && !from.includes(order.status))) return null
    Object.assign(order, Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)))
    order.updatedAt = new Date().toISOString()
    return this.copySo(order)
  }

  private copyApproval(approval: Approval): Approval {
    return {
      ...approval,
      waMessageIds: [...approval.waMessageIds],
      decidedByName: approval.decidedBy ? (this.users.find((user) => user.id === approval.decidedBy)?.name ?? null) : null,
    }
  }

  async createApproval(input: NewApproval): Promise<Approval> {
    const existing = this.approvals.find(
      (row) => row.subjectType === input.subjectType && row.subjectId === input.subjectId && row.version === input.version,
    )
    if (existing) return this.copyApproval(existing)
    const at = new Date(Date.now() + this.approvals.length).toISOString()
    const approval: Approval = {
      id: newId('apr'),
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      version: input.version,
      approverRole: input.approverRole,
      status: 'pending',
      channel: null,
      via: null,
      decidedBy: null,
      decidedByName: null,
      decidedAt: null,
      note: null,
      selfRaised: input.selfRaised,
      raisedBy: input.raisedBy,
      waMessageIds: [],
      taskId: null,
      soPdfId: input.soPdfId ?? null,
      annexId: input.annexId ?? null,
      createdAt: at,
      updatedAt: at,
    }
    this.approvals.push(approval)
    return this.copyApproval(approval)
  }

  async getApproval(id: string): Promise<Approval | null> {
    const approval = this.approvals.find((row) => row.id === id)
    return approval ? this.copyApproval(approval) : null
  }

  async listApprovals(
    filter: { status?: ApprovalStatus | null; subjectType?: string; subjectId?: string; limit?: number } = {},
  ): Promise<Approval[]> {
    return [...this.approvals]
      .filter(
        (row) =>
          (!filter.status || row.status === filter.status) &&
          (!filter.subjectType || row.subjectType === filter.subjectType) &&
          (!filter.subjectId || row.subjectId === filter.subjectId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 200)
      .map((row) => this.copyApproval(row))
  }

  async findApprovalByMessage(waMessageId: string): Promise<Approval | null> {
    const approval = this.approvals.find((row) => row.waMessageIds.includes(waMessageId))
    return approval ? this.copyApproval(approval) : null
  }

  private applyApproval(approval: Approval, patch: ApprovalPatch): void {
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (approval as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value
    }
    approval.updatedAt = new Date().toISOString()
  }

  async transitionApproval(id: string, version: number, from: ApprovalStatus, patch: ApprovalPatch): Promise<Approval | null> {
    const approval = this.approvals.find((row) => row.id === id)
    if (!approval || approval.version !== version || approval.status !== from) return null
    this.applyApproval(approval, patch)
    return this.copyApproval(approval)
  }

  async updateApproval(
    id: string,
    patch: Pick<ApprovalPatch, 'waMessageIds' | 'taskId' | 'soPdfId' | 'annexId'>,
  ): Promise<Approval | null> {
    const approval = this.approvals.find((row) => row.id === id)
    if (!approval) return null
    this.applyApproval(approval, patch)
    return this.copyApproval(approval)
  }

  async createProcurementRequests(rows: NewProcurementRequest[]): Promise<ProcurementRequest[]> {
    for (const row of rows) {
      const taken = this.procurementRequests.some(
        (request) => request.subjectId === row.subjectId && request.itemCode === row.itemCode && request.reason === row.reason,
      )
      if (taken) continue
      this.procurementRequests.push({
        ...row,
        id: newId('prq'),
        status: 'open',
        createdAt: new Date(Date.now() + this.procurementRequests.length).toISOString(),
      })
    }
    return rows.length ? this.listProcurementRequests({ subjectId: rows[0]!.subjectId }) : []
  }

  async listProcurementRequests(
    filter: { subjectId?: string; status?: ProcurementStatus | null; limit?: number } = {},
  ): Promise<ProcurementRequest[]> {
    return [...this.procurementRequests]
      .filter((row) => (!filter.subjectId || row.subjectId === filter.subjectId) && (!filter.status || row.status === filter.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.itemCode.localeCompare(b.itemCode))
      .slice(0, filter.limit ?? 500)
      .map((row) => ({ ...row }))
  }

  async closeProcurementRequests(subjectId: string, status: ProcurementStatus, reason?: string): Promise<number> {
    let changed = 0
    for (const row of this.procurementRequests) {
      if (row.subjectId !== subjectId || row.status !== 'open' || (reason && row.reason !== reason)) continue
      row.status = status
      changed += 1
    }
    return changed
  }

  async createStockAdjustment(input: NewStockAdjustment): Promise<StockAdjustment> {
    const at = new Date(Date.now() + this.stockAdjustments.length).toISOString()
    const adjustment: StockAdjustment = {
      ...input,
      id: newId('adj'),
      createdByName: this.userName(input.createdBy),
      status: 'active',
      effectiveAt: at,
      createdAt: at,
      closedAt: null,
      closedNote: null,
    }
    this.stockAdjustments.push(adjustment)
    return { ...adjustment }
  }

  async getStockAdjustment(id: string): Promise<StockAdjustment | null> {
    const row = this.stockAdjustments.find((adjustment) => adjustment.id === id)
    return row ? { ...row } : null
  }

  async closeStockAdjustment(id: string, status: 'absorbed' | 'cancelled', note: string, at: Date): Promise<StockAdjustment | null> {
    const row = this.stockAdjustments.find((adjustment) => adjustment.id === id)
    if (!row || row.status !== 'active') return null
    Object.assign(row, { status, closedAt: at.toISOString(), closedNote: note })
    return { ...row }
  }

  async listStockAdjustments(filter: { status?: StockAdjustment['status'] | null; limit?: number } = {}): Promise<StockAdjustment[]> {
    return [...this.stockAdjustments]
      .filter((row) => !filter.status || row.status === filter.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, filter.limit ?? 200)
      .map((row) => ({ ...row }))
  }

  async listDocuments(subjectType: string, subjectId: string): Promise<DocumentInfo[]> {
    return this.documents
      .filter((row) => row.subjectType === subjectType && row.subjectId === subjectId)
      .sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))
      .map((row) => ({
        id: row.id,
        filename: row.filename,
        kind: row.kind,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        version: row.version,
        createdAt: row.createdAt,
      }))
  }

  async reserveOutbound(message: ClaimedMessage & { idempotencyKey: string; at?: Date }): Promise<OutboundRow | null> {
    const existing = this.messages.find((row) => row.idempotencyKey === message.idempotencyKey)
    if (existing) {
      return {
        idempotencyKey: message.idempotencyKey,
        evolutionMessageId: existing.evolutionMessageId,
        status: existing.status ?? null,
        remoteJid: existing.remoteJid,
        createdAt: existing.createdAt,
      }
    }
    const { at, ...row } = message
    this.messages.push({
      ...row,
      evolutionMessageId: `outbound:${message.idempotencyKey}`,
      fromMe: true,
      status: 'sending',
      createdAt: (at ?? new Date()).toISOString(),
    })
    return null
  }

  async completeOutbound(idempotencyKey: string, evolutionMessageId: string | null): Promise<void> {
    const row = this.messages.find((message) => message.idempotencyKey === idempotencyKey)
    if (!row) return
    row.status = 'sent'
    if (evolutionMessageId) row.evolutionMessageId = evolutionMessageId
  }

  async setOutboundStatus(idempotencyKey: string, status: 'uncertain' | 'failed'): Promise<void> {
    const row = this.messages.find((message) => message.idempotencyKey === idempotencyKey)
    if (row) row.status = status
  }

  async findOutbound(idempotencyKey: string): Promise<OutboundRow | null> {
    const row = this.messages.find((message) => message.idempotencyKey === idempotencyKey)
    if (!row) return null
    return {
      idempotencyKey,
      evolutionMessageId: row.evolutionMessageId,
      status: row.status ?? null,
      remoteJid: row.remoteJid,
      createdAt: row.createdAt,
    }
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
    const chatOf = (job: JobRow) =>
      job.kind === 'wa.incoming' ? ((job.payload.message as { remoteJid?: string } | undefined)?.remoteJid ?? null) : null
    // a chat's turns one at a time, oldest first: never while another turn of that chat runs or waits ahead
    const blocked = (job: JobRow) => {
      const chat = chatOf(job)
      return (
        chat !== null &&
        this.jobs.some(
          (other) =>
            other !== job &&
            chatOf(other) === chat &&
            (other.status === 'running' || (other.status === 'queued' && other.seq < job.seq)),
        )
      )
    }
    const ready = this.jobs
      .filter((job) => job.status === 'queued' && new Date(job.runAfter) <= now && !blocked(job))
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

  async findJobByKey(idempotencyKey: string): Promise<JobRecord | null> {
    const job = this.jobs.find((row) => row.idempotencyKey === idempotencyKey)
    return job ? this.toJob(job) : null
  }

  async cancelQueuedJobs(kind: string, payload: Record<string, string>): Promise<number> {
    let cancelled = 0
    for (const job of this.jobs) {
      if (job.kind !== kind || job.status !== 'queued') continue
      if (!Object.entries(payload).every(([key, value]) => job.payload[key] === value)) continue
      job.status = 'cancelled'
      job.updatedAt = new Date().toISOString()
      cancelled += 1
    }
    return cancelled
  }

  async listGlLabels(): Promise<GlLabel[]> {
    return this.glLabels.map((row) => ({ ...row })).sort((a, b) => a.glCode.localeCompare(b.glCode))
  }

  async listBankLineReattributions(): Promise<BankLineReattribution[]> {
    return this.reattributions.map((row) => ({ ...row }))
  }

  async getDailyInputs(reportDate: string): Promise<DailyReportInputs | null> {
    const row = this.dailyInputs.get(reportDate)
    return row ? structuredClone(row) : null
  }

  async saveDailyInputs(reportDate: string, patch: DailyInputsPatch, by: { userId: string | null; at: Date }): Promise<DailyReportInputs> {
    const current: DailyReportInputs = this.dailyInputs.get(reportDate) ?? {
      reportDate,
      productionRun: null,
      packingRun: null,
      cartoningRun: null,
      manpower: null,
      bananaKgEstimate: null,
      cassavaKgEstimate: null,
      inwardRemarks: {},
      notes: null,
      enteredBy: null,
      enteredByName: null,
      enteredAt: null,
    }
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
    const next: DailyReportInputs = {
      ...current,
      ...structuredClone(defined),
      inwardRemarks: (defined.inwardRemarks as Record<string, string> | undefined) ?? current.inwardRemarks,
      enteredBy: by.userId,
      enteredByName: this.users.find((user) => user.id === by.userId)?.name ?? null,
      enteredAt: by.at.toISOString(),
    }
    this.dailyInputs.set(reportDate, next)
    return structuredClone(next)
  }

  async createDailyReport(input: NewDailyReport): Promise<DailyReportRecord> {
    const version = Math.max(0, ...this.dailyReports.filter((row) => row.reportDate === input.reportDate).map((row) => row.version)) + 1
    const record: DailyReportRecord = {
      ...input,
      payload: structuredClone(input.payload),
      id: newId('dr'),
      version,
      createdAt: new Date(Date.now() + this.dailyReports.length).toISOString(),
    }
    this.dailyReports.push(record)
    return structuredClone(record)
  }

  async latestDailyReport(reportDate: string): Promise<DailyReportRecord | null> {
    const rows = this.dailyReports.filter((row) => row.reportDate === reportDate).sort((a, b) => b.version - a.version)
    return rows[0] ? structuredClone(rows[0]) : null
  }

  async getSetting(key: string): Promise<unknown> {
    return this.settings.has(key) ? structuredClone(this.settings.get(key)) : null
  }

  async saveSetting(key: string, value: unknown): Promise<void> {
    this.settings.set(key, structuredClone(value))
  }
}

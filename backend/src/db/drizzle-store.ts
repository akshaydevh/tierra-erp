import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, ne, sql, type SQL } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import * as schema from './schema'
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
  Manpower,
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
  SalesOrderLine,
  SalesOrderPatch,
  SalesOrderStatus,
  StockAdjustment,
  AccountLink,
  ChatContext,
  CheckVerdict,
  ClaimedMessage,
  CustomerItemRef,
  CustomerPo,
  CustomerPoLine,
  CustomerPoPatch,
  CustomerPoStatus,
  CustomerPoSummary,
  CustomerSite,
  DocumentLink,
  InventoryCheck,
  InventoryCheckLine,
  ItemOwnerOverride,
  NewCustomerPo,
  NewInventoryCheck,
  PartyAlias,
  RepeatHit,
  StockOverlay,
  JobRecord,
  JobStatus,
  MessageKind,
  NewJob,
  NewPartyGroup,
  NewTask,
  PartyGroup,
  PartyMember,
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
  WhatsappStatus,
} from './types'
import {
  asOutwardsBasis,
  JOB_STATUSES,
  MESSAGE_KINDS,
  RESERVING_SO_STATUSES,
  asRole,
  asTaskCategory,
  asTaskKind,
  asTaskStatus,
  asTaskVia,
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

function toDailyInputs(row: typeof schema.dailyReportInputs.$inferSelect, enteredByName: string | null): DailyReportInputs {
  return {
    reportDate: row.reportDate,
    productionRun: row.productionRun,
    packingRun: row.packingRun,
    cartoningRun: row.cartoningRun,
    manpower: (row.manpower as Manpower | null) ?? null,
    bananaKgEstimate: row.bananaKgEstimate,
    cassavaKgEstimate: row.cassavaKgEstimate,
    inwardRemarks: row.inwardRemarks ?? {},
    notes: row.notes,
    enteredBy: row.enteredBy,
    enteredByName,
    enteredAt: row.enteredAt.toISOString(),
  }
}

function toDailyReport(row: typeof schema.dailyReports.$inferSelect): DailyReportRecord {
  return {
    id: row.id,
    reportDate: row.reportDate,
    version: row.version,
    basis: asOutwardsBasis(row.basis) ?? 'created_window',
    dataAsOf: row.dataAsOf,
    payload: row.payload,
    documentId: row.documentId,
    generatedBy: row.generatedBy,
    createdAt: row.createdAt.toISOString(),
  }
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

function toWaGroup(row: typeof schema.waGroups.$inferSelect): WaGroup {
  return {
    jid: row.jid,
    subject: row.subject,
    partyGroupId: row.partyGroupId,
    sendSo: row.sendSo,
    updatedAt: row.updatedAt.toISOString(),
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

  async transferAdmin(userId: string): Promise<'ok' | 'not_found'> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId))
      if (!target) return 'not_found'
      await tx
        .update(schema.users)
        .set({ role: 'manager' })
        .where(and(eq(schema.users.role, 'admin'), ne(schema.users.id, userId)))
      await tx.update(schema.users).set({ role: 'admin' }).where(eq(schema.users.id, userId))
      return 'ok'
    })
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
        id: schema.whatsappMessages.evolutionMessageId,
        remoteJid: schema.whatsappMessages.remoteJid,
        fromMe: schema.whatsappMessages.fromMe,
        body: schema.whatsappMessages.body,
        purpose: schema.whatsappMessages.purpose,
        createdAt: schema.whatsappMessages.createdAt,
      })
      .from(schema.whatsappMessages)
      .where(inArray(schema.whatsappMessages.remoteJid, remoteJids))
      .orderBy(desc(schema.whatsappMessages.createdAt), desc(schema.whatsappMessages.id))
      .limit(limit)
    return rows.reverse().map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }))
  }

  async markMessageAnswered(evolutionMessageId: string, at: Date): Promise<void> {
    await this.db
      .update(schema.whatsappMessages)
      .set({ answeredAt: at })
      .where(and(eq(schema.whatsappMessages.evolutionMessageId, evolutionMessageId), isNull(schema.whatsappMessages.answeredAt)))
  }

  async listThread(remoteJid: string): Promise<ThreadMessage[]> {
    const rows = await this.db
      .select({
        id: schema.whatsappMessages.evolutionMessageId,
        fromMe: schema.whatsappMessages.fromMe,
        hasPdf: schema.whatsappMessages.hasPdf,
        body: schema.whatsappMessages.body,
        createdAt: schema.whatsappMessages.createdAt,
        answeredAt: schema.whatsappMessages.answeredAt,
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
        answeredAt: row.answeredAt?.toISOString() ?? null,
      })
    }
    return [...thread.values()]
  }

  async releaseMessage(evolutionMessageId: string): Promise<void> {
    await this.db
      .delete(schema.whatsappMessages)
      .where(eq(schema.whatsappMessages.evolutionMessageId, evolutionMessageId))
  }

  async hasDocumentForMessage(messageId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: schema.orderDocuments.id })
      .from(schema.orderDocuments)
      .where(eq(schema.orderDocuments.messageId, messageId))
      .limit(1)
    return Boolean(row)
  }

  async insertDocument(input: StoredDocument & { messageId?: string | null } & Partial<DocumentLink>): Promise<string> {
    const id = newId('doc')
    await this.db.insert(schema.orderDocuments).values({
      id,
      messageId: input.messageId ?? null,
      filename: input.filename,
      mimeType: input.mimeType,
      content: input.content,
      kind: input.kind ?? 'other',
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      version: input.version ?? 1,
    })
    return id
  }

  async linkDocument(id: string, link: DocumentLink): Promise<void> {
    const set: Partial<typeof schema.orderDocuments.$inferInsert> = { kind: link.kind }
    if (link.subjectType !== undefined) set.subjectType = link.subjectType
    if (link.subjectId !== undefined) set.subjectId = link.subjectId
    if (link.version !== undefined) set.version = link.version
    await this.db.update(schema.orderDocuments).set(set).where(eq(schema.orderDocuments.id, id))
  }

  async getDocument(id: string): Promise<FetchedDocument | null> {
    const [row] = await this.db
      .select({
        filename: schema.orderDocuments.filename,
        mimeType: schema.orderDocuments.mimeType,
        content: schema.orderDocuments.content,
        kind: schema.orderDocuments.kind,
      })
      .from(schema.orderDocuments)
      .where(eq(schema.orderDocuments.id, id))
      .limit(1)
    return row ? { ...row, kind: row.kind as FetchedDocument['kind'] } : null
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
      assignedAt: task.assignedAt.toISOString(),
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

  async listUnnotifiedOpenTasks(): Promise<TaskRecord[]> {
    return this.selectTasks(
      and(
        inArray(schema.tasks.status, ['todo', 'doing']),
        isNotNull(schema.tasks.assigneeId),
        ne(schema.tasks.kind, 'approval'),
        isNull(schema.tasks.notifiedAt),
      ) as SQL,
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

  async cancelTasksForSubject(subjectType: string, subjectId: string): Promise<number> {
    const cancelled = await this.db
      .update(schema.tasks)
      .set({ status: 'cancelled' })
      .where(
        and(
          eq(schema.tasks.subjectType, subjectType),
          eq(schema.tasks.subjectId, subjectId),
          inArray(schema.tasks.status, ['todo', 'doing']),
        ),
      )
      .returning({ id: schema.tasks.id })
    return cancelled.length
  }

  async reopenTask(id: string, patch: { title: string; description: string | null }): Promise<TaskRecord | null> {
    const updated = await this.db
      .update(schema.tasks)
      .set({
        title: patch.title.trim(),
        description: patch.description,
        status: 'todo',
        completedAt: null,
        notifiedAt: null,
        waMessageId: null,
        assignedAt: new Date(),
      })
      .where(eq(schema.tasks.id, id))
      .returning({ id: schema.tasks.id })
    return updated.length ? this.getTask(id) : null
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
        assignedAt: sql`case when ${changed} then now() else ${schema.tasks.assignedAt} end`,
      })
      .where(eq(schema.tasks.id, id))
      .returning({ id: schema.tasks.id })
    if (updated.length === 0) return null
    return this.getTask(id)
  }

  async reserveTaskNotice(id: string, assigneeId: string): Promise<boolean> {
    const reserved = await this.db
      .update(schema.tasks)
      .set({ notifiedAt: sql`now()` })
      .where(and(eq(schema.tasks.id, id), eq(schema.tasks.assigneeId, assigneeId), isNull(schema.tasks.notifiedAt)))
      .returning({ id: schema.tasks.id })
    return reserved.length > 0
  }

  async releaseTaskNotice(id: string): Promise<void> {
    await this.db
      .update(schema.tasks)
      .set({ notifiedAt: null })
      .where(and(eq(schema.tasks.id, id), isNull(schema.tasks.waMessageId)))
  }

  async releaseStaleTaskNotices(before: Date): Promise<number> {
    const released = await this.db
      .update(schema.tasks)
      .set({ notifiedAt: null })
      .where(
        and(
          inArray(schema.tasks.status, ['todo', 'doing']),
          isNull(schema.tasks.waMessageId),
          lt(schema.tasks.notifiedAt, before),
        ),
      )
      .returning({ id: schema.tasks.id })
    return released.length
  }

  async markTaskNotified(id: string, waMessageId: string | null, at: Date): Promise<void> {
    await this.db.update(schema.tasks).set({ notifiedAt: at, waMessageId }).where(eq(schema.tasks.id, id))
  }

  private async partyGroupsWhere(where?: SQL): Promise<PartyGroup[]> {
    const groups = await this.db
      .select()
      .from(schema.partyGroups)
      .where(where)
      .orderBy(asc(schema.partyGroups.name))
    if (groups.length === 0) return []
    const members = await this.db
      .select()
      .from(schema.partyGroupMembers)
      .where(
        inArray(
          schema.partyGroupMembers.partyGroupId,
          groups.map((group) => group.id),
        ),
      )
      .orderBy(asc(schema.partyGroupMembers.kind), asc(schema.partyGroupMembers.value))
    return groups.map((group) => ({
      id: group.id,
      name: group.name,
      alias: group.alias,
      members: members
        .filter((member) => member.partyGroupId === group.id)
        .map((member) => ({ kind: member.kind as PartyMember['kind'], value: member.value })),
    }))
  }

  async listPartyGroups(): Promise<PartyGroup[]> {
    return this.partyGroupsWhere()
  }

  async getPartyGroup(id: string): Promise<PartyGroup | null> {
    const [group] = await this.partyGroupsWhere(eq(schema.partyGroups.id, id))
    return group ?? null
  }

  /** Writes the group and its members in one transaction; a taken name or member becomes PartyGroupConflictError. */
  private async writePartyGroup(id: string, input: NewPartyGroup, create: boolean): Promise<boolean> {
    const name = input.name.trim()
    const alias = input.alias?.trim() || null
    const members = normalizeMembers(input.members)
    try {
      return await this.db.transaction(async (tx) => {
        if (create) {
          await tx.insert(schema.partyGroups).values({ id, name, alias })
        } else {
          const updated = await tx
            .update(schema.partyGroups)
            .set({ name, alias, updatedAt: new Date() })
            .where(eq(schema.partyGroups.id, id))
            .returning({ id: schema.partyGroups.id })
          if (updated.length === 0) return false
          await tx.delete(schema.partyGroupMembers).where(eq(schema.partyGroupMembers.partyGroupId, id))
        }
        if (members.length > 0) {
          await tx.insert(schema.partyGroupMembers).values(members.map((member) => ({ partyGroupId: id, ...member })))
        }
        return true
      })
    } catch (error) {
      if (isUniqueViolation(error, 'party_groups_name_unique')) {
        throw new PartyGroupConflictError(`A party group called ${name} already exists`)
      }
      if (isUniqueViolation(error, 'party_group_members_kind_value_pk')) {
        const taken = await this.db
          .select({ value: schema.partyGroupMembers.value, owner: schema.partyGroups.name })
          .from(schema.partyGroupMembers)
          .innerJoin(schema.partyGroups, eq(schema.partyGroups.id, schema.partyGroupMembers.partyGroupId))
          .where(
            and(
              ne(schema.partyGroupMembers.partyGroupId, id),
              inArray(
                schema.partyGroupMembers.value,
                members.map((member) => member.value),
              ),
            ),
          )
          .limit(1)
        const first = taken[0]
        throw new PartyGroupConflictError(
          first ? `${first.value} already belongs to ${first.owner}` : 'A PAN or card code already belongs to another party group',
        )
      }
      throw error
    }
  }

  async createPartyGroup(input: NewPartyGroup): Promise<PartyGroup> {
    const id = newId('pty')
    await this.writePartyGroup(id, input, true)
    const created = await this.getPartyGroup(id)
    if (!created) throw new Error('Party group was not saved')
    return created
  }

  async updatePartyGroup(id: string, input: NewPartyGroup): Promise<PartyGroup | null> {
    if (!(await this.writePartyGroup(id, input, false))) return null
    return this.getPartyGroup(id)
  }

  async deletePartyGroup(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(schema.partyGroups)
      .where(eq(schema.partyGroups.id, id))
      .returning({ id: schema.partyGroups.id })
    return deleted.length > 0
  }

  async getWaGroup(jid: string): Promise<WaGroup | null> {
    const [row] = await this.db.select().from(schema.waGroups).where(eq(schema.waGroups.jid, jid)).limit(1)
    return row ? toWaGroup(row) : null
  }

  async listWaGroups(): Promise<WaGroup[]> {
    const rows = await this.db.select().from(schema.waGroups).orderBy(asc(schema.waGroups.subject), asc(schema.waGroups.jid))
    return rows.map(toWaGroup)
  }

  async saveWaGroup(jid: string, patch: WaGroupPatch): Promise<WaGroup> {
    const set: Partial<typeof schema.waGroups.$inferInsert> = { updatedAt: new Date() }
    if (patch.subject !== undefined) set.subject = patch.subject
    if (patch.partyGroupId !== undefined) set.partyGroupId = patch.partyGroupId
    if (patch.sendSo !== undefined) set.sendSo = patch.sendSo
    const [row] = await this.db
      .insert(schema.waGroups)
      .values({
        jid,
        subject: patch.subject ?? null,
        partyGroupId: patch.partyGroupId ?? null,
        sendSo: patch.sendSo ?? true,
      })
      .onConflictDoUpdate({ target: schema.waGroups.jid, set })
      .returning()
    return toWaGroup(row!)
  }

  async listCustomerSites(): Promise<CustomerSite[]> {
    const rows = await this.db
      .select()
      .from(schema.customerSites)
      .orderBy(asc(schema.customerSites.partyGroupId), asc(schema.customerSites.siteCode))
    return rows.map((row) => ({ partyGroupId: row.partyGroupId, siteCode: row.siteCode, cardCode: row.cardCode, note: row.note }))
  }

  async listCustomerItemRefs(partyGroupId?: string): Promise<CustomerItemRef[]> {
    const rows = await this.db
      .select()
      .from(schema.customerItemRefs)
      .where(partyGroupId ? eq(schema.customerItemRefs.partyGroupId, partyGroupId) : undefined)
      .orderBy(asc(schema.customerItemRefs.itemCode), asc(schema.customerItemRefs.id))
    return rows.map((row) => ({
      id: row.id,
      partyGroupId: row.partyGroupId,
      articleNo: row.articleNo,
      ean: row.ean,
      itemCode: row.itemCode,
      buyerUom: row.buyerUom,
      pcsPerUom: row.pcsPerUom,
      lastPrice: row.lastPrice,
      note: row.note,
    }))
  }

  async listItemOwnerOverrides(): Promise<ItemOwnerOverride[]> {
    const rows = await this.db.select().from(schema.itemOwnerOverrides).orderBy(asc(schema.itemOwnerOverrides.itemCode))
    return rows.map((row) => ({
      itemCode: row.itemCode,
      owner: row.owner === 'customer' ? 'customer' : 'tierra',
      ownerCardCode: row.ownerCardCode,
      note: row.note,
    }))
  }

  async listPartyAliases(): Promise<PartyAlias[]> {
    return this.db.select().from(schema.partyAliases).orderBy(asc(schema.partyAliases.cardCode))
  }

  private async customerPosWhere(where: SQL, limit?: number): Promise<CustomerPo[]> {
    let query = this.db
      .select({ po: schema.customerPos, partyName: schema.partyGroups.name })
      .from(schema.customerPos)
      .leftJoin(schema.partyGroups, eq(schema.partyGroups.id, schema.customerPos.partyGroupId))
      .where(where)
      .orderBy(desc(schema.customerPos.createdAt), desc(schema.customerPos.id))
      .$dynamic()
    if (limit) query = query.limit(limit)
    const rows = await query
    if (rows.length === 0) return []
    const lines = await this.db
      .select()
      .from(schema.customerPoLines)
      .where(inArray(schema.customerPoLines.customerPoId, rows.map((row) => row.po.id)))
      .orderBy(asc(schema.customerPoLines.lineNo))
    return rows.map(({ po, partyName }) => ({
      id: po.id,
      partyGroupId: po.partyGroupId,
      partyName,
      poNo: po.poNo,
      revision: po.revision,
      status: po.status as CustomerPoStatus,
      cardCode: po.cardCode,
      siteCode: po.siteCode,
      shipToGstin: po.shipToGstin,
      shipToAddress: po.shipToAddress,
      buyerName: po.buyerName,
      vendorCode: po.vendorCode,
      poDate: po.poDate,
      deliveryDate: po.deliveryDate,
      basicTotal: po.basicTotal,
      taxTotal: po.taxTotal,
      total: po.total,
      notes: po.notes,
      deliveryTerm: po.deliveryTerm,
      paymentTerms: po.paymentTerms,
      reader: po.reader,
      resolution: po.resolution,
      reviewReason: po.reviewReason,
      repeatOf: po.repeatOf as RepeatHit[],
      documentId: po.documentId,
      sourceChat: po.sourceChat,
      sourceMessageId: po.sourceMessageId,
      sourceSender: po.sourceSender,
      raisedBy: po.raisedBy,
      createdAt: po.createdAt.toISOString(),
      updatedAt: po.updatedAt.toISOString(),
      lines: lines
        .filter((line) => line.customerPoId === po.id)
        .map(({ customerPoId: _id, ...line }) => line as CustomerPoLine),
    }))
  }

  async createCustomerPo(input: NewCustomerPo): Promise<CustomerPo> {
    const id = newId('cpo')
    const { lines, revision, ...header } = input
    try {
      await this.db.transaction(async (tx) => {
        await tx.insert(schema.customerPos).values({ ...header, id, revision: revision ?? 1 })
        if (lines.length > 0) {
          await tx.insert(schema.customerPoLines).values(lines.map((line) => ({ ...line, customerPoId: id })))
        }
      })
    } catch (error) {
      if (isUniqueViolation(error, 'customer_pos_live')) throw new CustomerPoRevisionTakenError(input.poNo, revision ?? 1)
      throw error
    }
    const created = await this.getCustomerPo(id)
    if (!created) throw new Error('Customer PO was not saved')
    return created
  }

  async getCustomerPo(id: string): Promise<CustomerPo | null> {
    const [po] = await this.customerPosWhere(eq(schema.customerPos.id, id))
    return po ?? null
  }

  async findCustomerPoByMessage(messageId: string): Promise<CustomerPo | null> {
    const [po] = await this.customerPosWhere(eq(schema.customerPos.sourceMessageId, messageId))
    return po ?? null
  }

  async findCustomerPosByNumber(poNo: string): Promise<CustomerPo[]> {
    return this.customerPosWhere(and(eq(schema.customerPos.poNo, poNo), ne(schema.customerPos.status, 'cancelled'))!)
  }

  async listCustomerPos(filter: { limit?: number; status?: string | null } = {}): Promise<CustomerPoSummary[]> {
    const latest = this.db
      .selectDistinctOn([schema.inventoryChecks.customerPoId], {
        customerPoId: schema.inventoryChecks.customerPoId,
        verdict: schema.inventoryChecks.verdict,
      })
      .from(schema.inventoryChecks)
      .where(isNotNull(schema.inventoryChecks.customerPoId))
      .orderBy(schema.inventoryChecks.customerPoId, desc(schema.inventoryChecks.createdAt))
      .as('latest')
    const lineCount = this.db
      .select({ customerPoId: schema.customerPoLines.customerPoId, n: sql<number>`count(*)::int`.as('n') })
      .from(schema.customerPoLines)
      .groupBy(schema.customerPoLines.customerPoId)
      .as('line_count')
    const rows = await this.db
      .select({
        po: schema.customerPos,
        partyName: schema.partyGroups.name,
        verdict: latest.verdict,
        lines: lineCount.n,
      })
      .from(schema.customerPos)
      .leftJoin(schema.partyGroups, eq(schema.partyGroups.id, schema.customerPos.partyGroupId))
      .leftJoin(latest, eq(latest.customerPoId, schema.customerPos.id))
      .leftJoin(lineCount, eq(lineCount.customerPoId, schema.customerPos.id))
      .where(filter.status ? eq(schema.customerPos.status, filter.status) : undefined)
      .orderBy(desc(schema.customerPos.createdAt), desc(schema.customerPos.id))
      .limit(filter.limit ?? 100)
    return rows.map(({ po, partyName, verdict, lines }) => ({
      id: po.id,
      poNo: po.poNo,
      revision: po.revision,
      status: po.status as CustomerPoStatus,
      partyGroupId: po.partyGroupId,
      partyName,
      cardCode: po.cardCode,
      siteCode: po.siteCode,
      poDate: po.poDate,
      deliveryDate: po.deliveryDate,
      total: po.total,
      lineCount: lines ?? 0,
      verdict: (verdict as CheckVerdict | null) ?? null,
      repeat: po.repeatOf.length > 0,
      reviewReason: po.reviewReason,
      sourceChat: po.sourceChat,
      createdAt: po.createdAt.toISOString(),
    }))
  }

  async updateCustomerPo(id: string, patch: CustomerPoPatch): Promise<CustomerPo | null> {
    const set: Partial<typeof schema.customerPos.$inferInsert> = { updatedAt: new Date() }
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) (set as Record<string, unknown>)[key] = value
    }
    const updated = await this.db
      .update(schema.customerPos)
      .set(set)
      .where(eq(schema.customerPos.id, id))
      .returning({ id: schema.customerPos.id })
    return updated.length ? this.getCustomerPo(id) : null
  }

  async updateCustomerPoLines(id: string, lines: CustomerPoLine[]): Promise<CustomerPo | null> {
    const found = await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(schema.customerPos)
        .set({ updatedAt: new Date() })
        .where(eq(schema.customerPos.id, id))
        .returning({ id: schema.customerPos.id })
      if (!updated.length) return false
      await tx.delete(schema.customerPoLines).where(eq(schema.customerPoLines.customerPoId, id))
      if (lines.length > 0) await tx.insert(schema.customerPoLines).values(lines.map((line) => ({ ...line, customerPoId: id })))
      return true
    })
    return found ? this.getCustomerPo(id) : null
  }

  async saveInventoryCheck(input: NewInventoryCheck): Promise<InventoryCheck> {
    const id = newId('chk')
    const { lines, ...header } = input
    await this.db.transaction(async (tx) => {
      await tx.insert(schema.inventoryChecks).values({ ...header, id })
      if (lines.length > 0) {
        await tx
          .insert(schema.inventoryCheckLines)
          .values(lines.map((line, index) => ({ ...line, checkId: id, lineNo: index + 1 })))
      }
    })
    const saved = await this.getInventoryCheck(id)
    if (!saved) throw new Error('Inventory check was not saved')
    return saved
  }

  private async checkWhere(where: SQL): Promise<InventoryCheck | null> {
    const [check] = await this.db
      .select()
      .from(schema.inventoryChecks)
      .where(where)
      .orderBy(desc(schema.inventoryChecks.createdAt), desc(schema.inventoryChecks.id))
      .limit(1)
    if (!check) return null
    const lines = await this.db
      .select()
      .from(schema.inventoryCheckLines)
      .where(eq(schema.inventoryCheckLines.checkId, check.id))
      .orderBy(asc(schema.inventoryCheckLines.lineNo))
    return {
      id: check.id,
      customerPoId: check.customerPoId,
      kind: check.kind === 'dry_run' ? 'dry_run' : 'po',
      verdict: check.verdict as CheckVerdict,
      dataAsOf: check.dataAsOf,
      warnings: check.warnings,
      requested: check.requested as NewInventoryCheck['requested'],
      createdBy: check.createdBy,
      createdAt: check.createdAt.toISOString(),
      lines: lines.map(({ checkId: _checkId, lineNo: _lineNo, ...line }) => line as InventoryCheckLine),
    }
  }

  async getInventoryCheck(id: string): Promise<InventoryCheck | null> {
    return this.checkWhere(eq(schema.inventoryChecks.id, id))
  }

  async latestInventoryCheck(customerPoId: string): Promise<InventoryCheck | null> {
    return this.checkWhere(eq(schema.inventoryChecks.customerPoId, customerPoId))
  }

  async stockOverlays(itemCodes: readonly string[]): Promise<Record<string, StockOverlay>> {
    if (itemCodes.length === 0) return {}
    const codes = [...itemCodes]
    const reserving = [...RESERVING_SO_STATUSES]
    const [fg, components, adjustments] = await Promise.all([
      this.db
        .select({ itemCode: schema.salesOrderLines.itemCode, qty: sql<string>`sum(${schema.salesOrderLines.reservedPcs})` })
        .from(schema.salesOrderLines)
        .innerJoin(schema.salesOrders, eq(schema.salesOrders.id, schema.salesOrderLines.salesOrderId))
        .where(and(inArray(schema.salesOrders.status, reserving), inArray(schema.salesOrderLines.itemCode, codes)))
        .groupBy(schema.salesOrderLines.itemCode),
      this.db
        .select({ itemCode: schema.inventoryCheckLines.itemCode, qty: sql<string>`sum(${schema.inventoryCheckLines.need})` })
        .from(schema.inventoryCheckLines)
        .innerJoin(schema.salesOrders, eq(schema.salesOrders.checkId, schema.inventoryCheckLines.checkId))
        .where(
          and(
            inArray(schema.salesOrders.status, reserving),
            eq(schema.inventoryCheckLines.kind, 'component'),
            inArray(schema.inventoryCheckLines.itemCode, codes),
          ),
        )
        .groupBy(schema.inventoryCheckLines.itemCode),
      this.db
        .select({ itemCode: schema.stockAdjustments.itemCode, qty: sql<string>`sum(${schema.stockAdjustments.qty})` })
        .from(schema.stockAdjustments)
        .where(and(eq(schema.stockAdjustments.status, 'active'), inArray(schema.stockAdjustments.itemCode, codes)))
        .groupBy(schema.stockAdjustments.itemCode),
    ])
    const out: Record<string, StockOverlay> = {}
    const entry = (code: string) => (out[code] ??= { reserved: 0, adjustments: 0 })
    for (const row of [...fg, ...components]) entry(row.itemCode).reserved += Number(row.qty)
    for (const row of adjustments) entry(row.itemCode).adjustments += Number(row.qty)
    return out
  }

  // ------------------------------------------------------------------------------------------ P4: sales orders

  private async salesOrdersWhere(where: SQL | undefined, limit?: number): Promise<SalesOrder[]> {
    let query = this.db
      .select({ so: schema.salesOrders, partyName: schema.partyGroups.name })
      .from(schema.salesOrders)
      .leftJoin(schema.partyGroups, eq(schema.partyGroups.id, schema.salesOrders.partyGroupId))
      .where(where)
      .orderBy(desc(schema.salesOrders.createdAt), desc(schema.salesOrders.id))
      .$dynamic()
    if (limit) query = query.limit(limit)
    const rows = await query
    if (rows.length === 0) return []
    const lines = await this.db
      .select()
      .from(schema.salesOrderLines)
      .where(inArray(schema.salesOrderLines.salesOrderId, rows.map((row) => row.so.id)))
      .orderBy(asc(schema.salesOrderLines.lineNo))
    return rows.map(({ so, partyName }) => ({
      id: so.id,
      docNo: so.docNo,
      series: so.series,
      fy: so.fy,
      seq: so.seq,
      version: so.version,
      customerPoId: so.customerPoId,
      partyGroupId: so.partyGroupId,
      partyName,
      cardCode: so.cardCode,
      checkId: so.checkId,
      status: so.status as SalesOrderStatus,
      docDate: so.docDate,
      deliveryDate: so.deliveryDate,
      customerPoNo: so.customerPoNo,
      poDate: so.poDate,
      vendorCode: so.vendorCode,
      siteCode: so.siteCode,
      shipToGstin: so.shipToGstin,
      placeOfSupply: so.placeOfSupply,
      stateCode: so.stateCode,
      taxKind: so.taxKind === 'igst' ? 'igst' : 'cgst_sgst',
      basicTotal: so.basicTotal,
      cgst: so.cgst,
      sgst: so.sgst,
      igst: so.igst,
      cess: so.cess,
      taxTotal: so.taxTotal,
      total: so.total,
      deliveryTerm: so.deliveryTerm,
      paymentTerms: so.paymentTerms,
      notes: so.notes,
      createdBy: so.createdBy,
      approvedBy: so.approvedBy,
      approvedAt: so.approvedAt?.toISOString() ?? null,
      sentAt: so.sentAt?.toISOString() ?? null,
      sapDocEntry: so.sapDocEntry,
      sapDocNo: so.sapDocNo,
      cancelledAt: so.cancelledAt?.toISOString() ?? null,
      createdAt: so.createdAt.toISOString(),
      updatedAt: so.updatedAt.toISOString(),
      lines: lines
        .filter((line) => line.salesOrderId === so.id)
        .map(({ salesOrderId: _id, ...line }) => line as SalesOrderLine),
    }))
  }

  async createSalesOrder(
    input: NewSalesOrder,
    numbering: { series: string; fy: string },
  ): Promise<{ order: SalesOrder; created: boolean }> {
    const live = input.customerPoId ? await this.findSalesOrderForPo(input.customerPoId) : null
    if (live) return { order: live, created: false }
    const id = newId('tso')
    const { lines, ...header } = input
    try {
      await this.db.transaction(async (tx) => {
        const [counter] = await tx
          .insert(schema.docCounters)
          .values({ series: numbering.series, fy: numbering.fy, next: 2 })
          .onConflictDoUpdate({
            target: [schema.docCounters.series, schema.docCounters.fy],
            set: { next: sql`${schema.docCounters.next} + 1`, updatedAt: new Date() },
          })
          .returning({ next: schema.docCounters.next })
        const seq = counter!.next - 1
        const docNo = `${numbering.series}/${numbering.fy}/${String(seq).padStart(4, '0')}`
        await tx.insert(schema.salesOrders).values({ ...header, id, docNo, series: numbering.series, fy: numbering.fy, seq })
        if (lines.length > 0) {
          await tx.insert(schema.salesOrderLines).values(lines.map((line) => ({ ...line, salesOrderId: id })))
        }
      })
    } catch (error) {
      if (isUniqueViolation(error, 'sales_orders_live_po') && input.customerPoId) {
        const existing = await this.findSalesOrderForPo(input.customerPoId)
        if (existing) return { order: existing, created: false }
      }
      throw error
    }
    const order = await this.getSalesOrder(id)
    if (!order) throw new Error('Sales order was not saved')
    return { order, created: true }
  }

  async getSalesOrder(id: string): Promise<SalesOrder | null> {
    const [order] = await this.salesOrdersWhere(eq(schema.salesOrders.id, id))
    return order ?? null
  }

  async findSalesOrderByNo(docNo: string): Promise<SalesOrder | null> {
    const [order] = await this.salesOrdersWhere(eq(schema.salesOrders.docNo, docNo.toUpperCase()))
    return order ?? null
  }

  async findSalesOrderForPo(customerPoId: string): Promise<SalesOrder | null> {
    const [order] = await this.salesOrdersWhere(
      and(
        eq(schema.salesOrders.customerPoId, customerPoId),
        sql`${schema.salesOrders.status} not in ('cancelled', 'rejected')`,
      ),
    )
    return order ?? null
  }

  async listSalesOrders(filter: { status?: SalesOrderStatus | null; limit?: number } = {}): Promise<SalesOrder[]> {
    return this.salesOrdersWhere(filter.status ? eq(schema.salesOrders.status, filter.status) : undefined, filter.limit ?? 200)
  }

  async updateSalesOrder(id: string, patch: SalesOrderPatch, from?: readonly SalesOrderStatus[]): Promise<SalesOrder | null> {
    const set: Partial<typeof schema.salesOrders.$inferInsert> = { updatedAt: new Date() }
    if (patch.status !== undefined) set.status = patch.status
    if (patch.version !== undefined) set.version = patch.version
    if (patch.approvedBy !== undefined) set.approvedBy = patch.approvedBy
    if (patch.approvedAt !== undefined) set.approvedAt = patch.approvedAt ? new Date(patch.approvedAt) : null
    if (patch.sentAt !== undefined) set.sentAt = patch.sentAt ? new Date(patch.sentAt) : null
    if (patch.sapDocEntry !== undefined) set.sapDocEntry = patch.sapDocEntry
    if (patch.sapDocNo !== undefined) set.sapDocNo = patch.sapDocNo
    if (patch.cancelledAt !== undefined) set.cancelledAt = patch.cancelledAt ? new Date(patch.cancelledAt) : null
    const updated = await this.db
      .update(schema.salesOrders)
      .set(set)
      .where(and(eq(schema.salesOrders.id, id), from ? inArray(schema.salesOrders.status, [...from]) : undefined))
      .returning({ id: schema.salesOrders.id })
    return updated.length ? this.getSalesOrder(id) : null
  }

  private async approvalsWhere(where: SQL | undefined, limit = 200): Promise<Approval[]> {
    const rows = await this.db
      .select({ approval: schema.approvals, decidedByName: schema.users.name })
      .from(schema.approvals)
      .leftJoin(schema.users, eq(schema.users.id, schema.approvals.decidedBy))
      .where(where)
      .orderBy(desc(schema.approvals.createdAt), desc(schema.approvals.id))
      .limit(limit)
    return rows.map(({ approval, decidedByName }) => ({
      id: approval.id,
      subjectType: approval.subjectType,
      subjectId: approval.subjectId,
      version: approval.version,
      approverRole: asRole(approval.approverRole),
      status: approval.status as ApprovalStatus,
      channel: (approval.channel as Approval['channel']) ?? null,
      via: (approval.via as Approval['via']) ?? null,
      decidedBy: approval.decidedBy,
      decidedByName,
      decidedAt: approval.decidedAt?.toISOString() ?? null,
      note: approval.note,
      selfRaised: approval.selfRaised,
      raisedBy: approval.raisedBy,
      waMessageIds: approval.waMessageIds,
      taskId: approval.taskId,
      soPdfId: approval.soPdfId,
      annexId: approval.annexId,
      createdAt: approval.createdAt.toISOString(),
      updatedAt: approval.updatedAt.toISOString(),
    }))
  }

  async createApproval(input: NewApproval): Promise<Approval> {
    const id = newId('apr')
    await this.db
      .insert(schema.approvals)
      .values({
        id,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        version: input.version,
        approverRole: input.approverRole,
        selfRaised: input.selfRaised,
        raisedBy: input.raisedBy,
        soPdfId: input.soPdfId ?? null,
        annexId: input.annexId ?? null,
      })
      .onConflictDoNothing({ target: [schema.approvals.subjectType, schema.approvals.subjectId, schema.approvals.version] })
    const [approval] = await this.approvalsWhere(
      and(
        eq(schema.approvals.subjectType, input.subjectType),
        eq(schema.approvals.subjectId, input.subjectId),
        eq(schema.approvals.version, input.version),
      ),
    )
    if (!approval) throw new Error('Approval was not saved')
    return approval
  }

  async getApproval(id: string): Promise<Approval | null> {
    const [approval] = await this.approvalsWhere(eq(schema.approvals.id, id))
    return approval ?? null
  }

  async listApprovals(
    filter: { status?: ApprovalStatus | null; subjectType?: string; subjectId?: string; limit?: number } = {},
  ): Promise<Approval[]> {
    return this.approvalsWhere(
      and(
        filter.status ? eq(schema.approvals.status, filter.status) : undefined,
        filter.subjectType ? eq(schema.approvals.subjectType, filter.subjectType) : undefined,
        filter.subjectId ? eq(schema.approvals.subjectId, filter.subjectId) : undefined,
      ),
      filter.limit ?? 200,
    )
  }

  async findApprovalByMessage(waMessageId: string): Promise<Approval | null> {
    const [approval] = await this.approvalsWhere(
      sql`${schema.approvals.waMessageIds} @> ${JSON.stringify([waMessageId])}::jsonb`,
    )
    return approval ?? null
  }

  private approvalSet(patch: ApprovalPatch): Partial<typeof schema.approvals.$inferInsert> {
    const set: Partial<typeof schema.approvals.$inferInsert> = { updatedAt: new Date() }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      ;(set as Record<string, unknown>)[key] = key === 'decidedAt' && value ? new Date(value as string) : value
    }
    return set
  }

  async transitionApproval(id: string, version: number, from: ApprovalStatus, patch: ApprovalPatch): Promise<Approval | null> {
    const updated = await this.db
      .update(schema.approvals)
      .set(this.approvalSet(patch))
      .where(and(eq(schema.approvals.id, id), eq(schema.approvals.version, version), eq(schema.approvals.status, from)))
      .returning({ id: schema.approvals.id })
    return updated.length ? this.getApproval(id) : null
  }

  async updateApproval(
    id: string,
    patch: Pick<ApprovalPatch, 'waMessageIds' | 'taskId' | 'soPdfId' | 'annexId'>,
  ): Promise<Approval | null> {
    const updated = await this.db
      .update(schema.approvals)
      .set(this.approvalSet(patch))
      .where(eq(schema.approvals.id, id))
      .returning({ id: schema.approvals.id })
    return updated.length ? this.getApproval(id) : null
  }

  private toRequest(row: typeof schema.procurementRequests.$inferSelect): ProcurementRequest {
    return {
      id: row.id,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      customerPoId: row.customerPoId,
      salesOrderId: row.salesOrderId,
      itemCode: row.itemCode,
      itemName: row.itemName,
      qty: row.qty,
      uom: row.uom,
      reason: row.reason as ProcurementRequest['reason'],
      status: row.status as ProcurementStatus,
      taskId: row.taskId,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async createProcurementRequests(rows: NewProcurementRequest[]): Promise<ProcurementRequest[]> {
    if (rows.length === 0) return []
    await this.db
      .insert(schema.procurementRequests)
      .values(rows.map((row) => ({ ...row, id: newId('prq') })))
      .onConflictDoNothing({
        target: [schema.procurementRequests.subjectId, schema.procurementRequests.itemCode, schema.procurementRequests.reason],
      })
    return this.listProcurementRequests({ subjectId: rows[0]!.subjectId })
  }

  async listProcurementRequests(
    filter: { subjectId?: string; status?: ProcurementStatus | null; limit?: number } = {},
  ): Promise<ProcurementRequest[]> {
    const rows = await this.db
      .select()
      .from(schema.procurementRequests)
      .where(
        and(
          filter.subjectId ? eq(schema.procurementRequests.subjectId, filter.subjectId) : undefined,
          filter.status ? eq(schema.procurementRequests.status, filter.status) : undefined,
        ),
      )
      .orderBy(desc(schema.procurementRequests.createdAt), asc(schema.procurementRequests.itemCode))
      .limit(filter.limit ?? 500)
    return rows.map((row) => this.toRequest(row))
  }

  async closeProcurementRequests(subjectId: string, status: ProcurementStatus, reason?: string): Promise<number> {
    const updated = await this.db
      .update(schema.procurementRequests)
      .set({ status, updatedAt: new Date() })
      .where(
        and(
          eq(schema.procurementRequests.subjectId, subjectId),
          eq(schema.procurementRequests.status, 'open'),
          reason ? eq(schema.procurementRequests.reason, reason) : undefined,
        ),
      )
      .returning({ id: schema.procurementRequests.id })
    return updated.length
  }

  async createStockAdjustment(input: NewStockAdjustment): Promise<StockAdjustment> {
    const id = newId('adj')
    await this.db.insert(schema.stockAdjustments).values({ ...input, id })
    const [row] = await this.listStockAdjustmentsWhere(eq(schema.stockAdjustments.id, id), 1)
    if (!row) throw new Error('Stock adjustment was not saved')
    return row
  }

  private async listStockAdjustmentsWhere(where: SQL | undefined, limit: number): Promise<StockAdjustment[]> {
    const rows = await this.db
      .select({ adj: schema.stockAdjustments, name: schema.users.name })
      .from(schema.stockAdjustments)
      .leftJoin(schema.users, eq(schema.users.id, schema.stockAdjustments.createdBy))
      .where(where)
      .orderBy(desc(schema.stockAdjustments.createdAt), desc(schema.stockAdjustments.id))
      .limit(limit)
    return rows.map(({ adj, name }) => ({
      id: adj.id,
      itemCode: adj.itemCode,
      qty: adj.qty,
      uom: adj.uom,
      reason: adj.reason,
      note: adj.note,
      taskId: adj.taskId,
      createdBy: adj.createdBy,
      createdByName: name,
      createdVia: asTaskVia(adj.createdVia),
      status: adj.status as StockAdjustment['status'],
      effectiveAt: adj.effectiveAt.toISOString(),
      createdAt: adj.createdAt.toISOString(),
      closedAt: adj.closedAt?.toISOString() ?? null,
      closedNote: adj.closedNote,
    }))
  }

  async getStockAdjustment(id: string): Promise<StockAdjustment | null> {
    const [row] = await this.listStockAdjustmentsWhere(eq(schema.stockAdjustments.id, id), 1)
    return row ?? null
  }

  async closeStockAdjustment(id: string, status: 'absorbed' | 'cancelled', note: string, at: Date): Promise<StockAdjustment | null> {
    const updated = await this.db
      .update(schema.stockAdjustments)
      .set({ status, closedAt: at, closedNote: note })
      .where(and(eq(schema.stockAdjustments.id, id), eq(schema.stockAdjustments.status, 'active')))
      .returning({ id: schema.stockAdjustments.id })
    return updated.length ? this.getStockAdjustment(id) : null
  }

  async listStockAdjustments(filter: { status?: StockAdjustment['status'] | null; limit?: number } = {}): Promise<StockAdjustment[]> {
    return this.listStockAdjustmentsWhere(
      filter.status ? eq(schema.stockAdjustments.status, filter.status) : undefined,
      filter.limit ?? 200,
    )
  }

  async listDocuments(subjectType: string, subjectId: string): Promise<DocumentInfo[]> {
    const rows = await this.db
      .select({
        id: schema.orderDocuments.id,
        filename: schema.orderDocuments.filename,
        kind: schema.orderDocuments.kind,
        subjectType: schema.orderDocuments.subjectType,
        subjectId: schema.orderDocuments.subjectId,
        version: schema.orderDocuments.version,
        createdAt: schema.orderDocuments.createdAt,
      })
      .from(schema.orderDocuments)
      .where(and(eq(schema.orderDocuments.subjectType, subjectType), eq(schema.orderDocuments.subjectId, subjectId)))
      .orderBy(desc(schema.orderDocuments.version), desc(schema.orderDocuments.createdAt))
    return rows.map((row) => ({ ...row, kind: row.kind as DocumentInfo['kind'], createdAt: row.createdAt.toISOString() }))
  }

  private async outboundByKey(idempotencyKey: string): Promise<OutboundRow | null> {
    const [row] = await this.db
      .select()
      .from(schema.whatsappMessages)
      .where(eq(schema.whatsappMessages.idempotencyKey, idempotencyKey))
      .limit(1)
    if (!row) return null
    return {
      idempotencyKey,
      evolutionMessageId: row.evolutionMessageId,
      status: (row.status as OutboundRow['status']) ?? null,
      remoteJid: row.remoteJid,
      createdAt: row.createdAt.toISOString(),
    }
  }

  async reserveOutbound(message: ClaimedMessage & { idempotencyKey: string; at?: Date }): Promise<OutboundRow | null> {
    const inserted = await this.db
      .insert(schema.whatsappMessages)
      .values({
        id: newId('msg'),
        evolutionMessageId: `outbound:${message.idempotencyKey}`,
        remoteJid: message.remoteJid,
        fromMe: true,
        hasPdf: message.hasPdf,
        body: message.body,
        kind: message.kind ?? 'text',
        purpose: message.purpose ?? null,
        subjectType: message.subjectType ?? null,
        subjectId: message.subjectId ?? null,
        status: 'sending',
        idempotencyKey: message.idempotencyKey,
        ...(message.at ? { createdAt: message.at } : {}),
      })
      .onConflictDoNothing()
      .returning({ id: schema.whatsappMessages.id })
    if (inserted.length > 0) return null
    const existing = await this.outboundByKey(message.idempotencyKey)
    if (!existing) throw new Error(`Outbound ${message.idempotencyKey} could not be reserved`)
    return existing
  }

  async completeOutbound(idempotencyKey: string, evolutionMessageId: string | null): Promise<void> {
    await this.db
      .update(schema.whatsappMessages)
      .set({
        status: 'sent',
        ...(evolutionMessageId ? { evolutionMessageId } : {}),
      })
      .where(eq(schema.whatsappMessages.idempotencyKey, idempotencyKey))
  }

  async setOutboundStatus(idempotencyKey: string, status: 'uncertain' | 'failed'): Promise<void> {
    await this.db
      .update(schema.whatsappMessages)
      .set({ status })
      .where(eq(schema.whatsappMessages.idempotencyKey, idempotencyKey))
  }

  async findOutbound(idempotencyKey: string): Promise<OutboundRow | null> {
    return this.outboundByKey(idempotencyKey)
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
        .where(
          and(
            eq(schema.jobs.status, 'queued'),
            lte(schema.jobs.runAfter, now),
            // a chat's turns one at a time, oldest first: never while another turn of that chat runs or waits ahead
            sql`(${schema.jobs.kind} <> 'wa.incoming' or not exists (
              select 1 from jobs other
              where other.kind = 'wa.incoming' and other.id <> ${schema.jobs.id}
                and other.payload->'message'->>'remoteJid' = ${schema.jobs.payload}->'message'->>'remoteJid'
                and (other.status = 'running'
                     or (other.status = 'queued' and (other.created_at, other.id) < (${schema.jobs.createdAt}, ${schema.jobs.id})))))`,
          ),
        )
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

  async pruneJobs(before: Date): Promise<number> {
    const pruned = await this.db
      .delete(schema.jobs)
      .where(and(inArray(schema.jobs.status, ['done', 'failed', 'cancelled']), lt(schema.jobs.updatedAt, before)))
      .returning({ id: schema.jobs.id })
    return pruned.length
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const [row] = await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1)
    return row ? toJob(row) : null
  }

  async findJobByKey(idempotencyKey: string): Promise<JobRecord | null> {
    const [row] = await this.db.select().from(schema.jobs).where(eq(schema.jobs.idempotencyKey, idempotencyKey)).limit(1)
    return row ? toJob(row) : null
  }

  async cancelQueuedJobs(kind: string, payload: Record<string, string>): Promise<number> {
    const cancelled = await this.db
      .update(schema.jobs)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(schema.jobs.kind, kind),
          eq(schema.jobs.status, 'queued'),
          sql`${schema.jobs.payload} @> ${JSON.stringify(payload)}::jsonb`,
        ),
      )
      .returning({ id: schema.jobs.id })
    return cancelled.length
  }

  async listGlLabels(): Promise<GlLabel[]> {
    const rows = await this.db.select().from(schema.glLabels).orderBy(asc(schema.glLabels.glCode))
    return rows.map((row) => ({ glCode: row.glCode, label: row.label, preferPayee: row.preferPayee }))
  }

  async listBankLineReattributions(): Promise<BankLineReattribution[]> {
    const rows = await this.db
      .select()
      .from(schema.bankLineReattributions)
      .orderBy(asc(schema.bankLineReattributions.transId), asc(schema.bankLineReattributions.lineId))
    return rows.map((row) => ({ transId: row.transId, lineId: row.lineId, reportDate: row.reportDate, note: row.note }))
  }

  async getDailyInputs(reportDate: string): Promise<DailyReportInputs | null> {
    const [row] = await this.db
      .select({ inputs: schema.dailyReportInputs, name: schema.users.name })
      .from(schema.dailyReportInputs)
      .leftJoin(schema.users, eq(schema.users.id, schema.dailyReportInputs.enteredBy))
      .where(eq(schema.dailyReportInputs.reportDate, reportDate))
      .limit(1)
    return row ? toDailyInputs(row.inputs, row.name) : null
  }

  async saveDailyInputs(reportDate: string, patch: DailyInputsPatch, by: { userId: string | null; at: Date }): Promise<DailyReportInputs> {
    const set: Partial<typeof schema.dailyReportInputs.$inferInsert> = { enteredBy: by.userId, enteredAt: by.at }
    if (patch.productionRun !== undefined) set.productionRun = patch.productionRun
    if (patch.packingRun !== undefined) set.packingRun = patch.packingRun
    if (patch.cartoningRun !== undefined) set.cartoningRun = patch.cartoningRun
    if (patch.manpower !== undefined) set.manpower = patch.manpower
    if (patch.bananaKgEstimate !== undefined) set.bananaKgEstimate = patch.bananaKgEstimate
    if (patch.cassavaKgEstimate !== undefined) set.cassavaKgEstimate = patch.cassavaKgEstimate
    if (patch.inwardRemarks !== undefined) set.inwardRemarks = patch.inwardRemarks
    if (patch.notes !== undefined) set.notes = patch.notes
    await this.db
      .insert(schema.dailyReportInputs)
      .values({ reportDate, ...set })
      .onConflictDoUpdate({ target: schema.dailyReportInputs.reportDate, set })
    const saved = await this.getDailyInputs(reportDate)
    if (!saved) throw new Error(`Daily inputs for ${reportDate} were not saved`)
    return saved
  }

  async createDailyReport(input: NewDailyReport): Promise<DailyReportRecord> {
    // the next version of the day; a concurrent insert of the same version hits the unique index and retries
    for (let attempt = 0; ; attempt += 1) {
      try {
        const [row] = await this.db
          .insert(schema.dailyReports)
          .values({
            id: newId('dr'),
            reportDate: input.reportDate,
            version: sql`(select coalesce(max(${schema.dailyReports.version}), 0) + 1 from ${schema.dailyReports} where ${schema.dailyReports.reportDate} = ${input.reportDate})`,
            basis: input.basis,
            dataAsOf: input.dataAsOf,
            payload: input.payload,
            documentId: input.documentId,
            generatedBy: input.generatedBy,
          })
          .returning()
        return toDailyReport(row!)
      } catch (error) {
        if (attempt < 3 && isUniqueViolation(error, 'daily_reports_date_version')) continue
        throw error
      }
    }
  }

  async latestDailyReport(reportDate: string): Promise<DailyReportRecord | null> {
    const [row] = await this.db
      .select()
      .from(schema.dailyReports)
      .where(eq(schema.dailyReports.reportDate, reportDate))
      .orderBy(desc(schema.dailyReports.version))
      .limit(1)
    return row ? toDailyReport(row) : null
  }

  async getSetting(key: string): Promise<unknown> {
    const [row] = await this.db.select({ value: schema.appSettings.value }).from(schema.appSettings).where(eq(schema.appSettings.key, key)).limit(1)
    return row ? row.value : null
  }

  async saveSetting(key: string, value: unknown, by: string | null): Promise<void> {
    await this.db
      .insert(schema.appSettings)
      .values({ key, value, updatedBy: by, updatedAt: new Date() })
      .onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedBy: by, updatedAt: new Date() } })
  }
}

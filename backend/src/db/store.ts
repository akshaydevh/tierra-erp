import type { StockShortError } from '../domain/inventory'
import type {
  Balance,
  ClaimedMessage,
  Customer,
  Item,
  NewOrderLine,
  OrderLineRecord,
  OrderRecord,
  AccountLink,
  ChatContext,
  JobRecord,
  NewJob,
  NewTask,
  ProcurementOrderRecord,
  ProductionEntryRecord,
  PendingConfirmation,
  ProductionPlan,
  PublicUser,
  Role,
  StoredDocument,
  StoredMessage,
  TaskCategory,
  TaskRecord,
  TaskStatus,
  User,
  WhatsappConnection,
  WhatsappStatus,
} from './types'

export type { StockShortError }

export type RecentMessage = {
  remoteJid: string
  fromMe: boolean
  body: string | null
}

export type ThreadMessage = {
  id: string
  fromMe: boolean
  hasPdf: boolean
  body: string | null
  filename: string | null
  createdAt: string
}

export interface Store {
  findUserByEmail(email: string): Promise<User | null>
  createSession(input: { userId: string; tokenHash: string; expiresAt: Date }): Promise<void>
  findUserByTokenHash(tokenHash: string, now: Date): Promise<PublicUser | null>
  deleteSession(tokenHash: string): Promise<void>
  listAccountLinks(): Promise<AccountLink[]>
  saveRelation(input: { userId: string; phoneNumber: string }): Promise<void>
  deleteRelation(userId: string): Promise<void>
  /** Changes a user's role. There is only ever one admin: giving admin to a second user returns 'admin_taken'. */
  updateUserRole(userId: string, role: Role): Promise<'ok' | 'not_found' | 'admin_taken'>
  /** Makes this user the admin and the current admin a manager, in one transaction. */
  transferAdmin(userId: string): Promise<'ok' | 'not_found'>

  listCustomers(): Promise<Customer[]>
  listItems(): Promise<Item[]>
  listBalances(): Promise<Balance[]>
  listOrders(): Promise<OrderRecord[]>
  listOrderLines(): Promise<OrderLineRecord[]>
  listProductionEntries(): Promise<ProductionEntryRecord[]>
  listProcurementOrders(): Promise<ProcurementOrderRecord[]>
  orderHasDocument(orderId: string): Promise<boolean>
  getOrderDocument(orderId: string): Promise<StoredDocument | null>

  getWhatsapp(): Promise<WhatsappConnection>
  saveWhatsapp(
    patch: Partial<Pick<WhatsappConnection, 'status' | 'qrBase64' | 'phoneNumber'>> & {
      status?: WhatsappStatus
    },
  ): Promise<WhatsappConnection>

  /** Inserts a registry row. Returns false when that Evolution id is already stored (dedupe). */
  claimMessage(message: ClaimedMessage): Promise<boolean>
  findMessage(evolutionMessageId: string): Promise<StoredMessage | null>
  /** Remembers that a WhatsApp LID (e.g. 12345@lid) belongs to a phone (digits only). */
  saveIdentity(lid: string, phone: string): Promise<void>
  phoneForLid(lid: string): Promise<string | null>
  getChatContext(chatJid: string): Promise<ChatContext | null>
  setChatContext(chatJid: string, subjectType: string, subjectId: string): Promise<void>
  listRecentMessages(remoteJids: string[], limit: number): Promise<RecentMessage[]>
  listThread(remoteJid: string): Promise<ThreadMessage[]>
  releaseMessage(evolutionMessageId: string): Promise<void>
  /** True when a PDF from this WhatsApp message was already stored, so the message was already handled. */
  hasDocumentForMessage(messageId: string): Promise<boolean>
  insertDocument(input: StoredDocument & { messageId: string }): Promise<string>
  createOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    remoteJid: string
    lines: NewOrderLine[]
    document: StoredDocument & { messageId: string }
    production: ProductionPlan | null
  }): Promise<{ id: string; productionEntryId: string | null; procurementOrderId: string | null }>
  holdShortOrder(input: {
    customerId: string
    poNumber: string
    poDate: string | null
    remoteJid: string
    documentId: string
    lines: NewOrderLine[]
    shortages: Array<{ itemId: string; quantity: number; unit: string }>
    assigneeId: string
  }): Promise<{ id: string }>
  /** Held orders waiting for the admin's YES or NO in this chat, newest first. */
  listAwaitingConfirmations(remoteJid: string): Promise<PendingConfirmation[]>
  confirmPendingOrder(
    id: string,
    production: ProductionPlan | null,
  ): Promise<{ id: string; poNumber: string; productionEntryId: string | null; procurementOrderId: string | null } | null>
  declinePendingOrder(id: string): Promise<{ poNumber: string } | null>

  listTasks(): Promise<TaskRecord[]>
  getTask(id: string): Promise<TaskRecord | null>
  /** Open (todo/doing) tasks held by this user, newest first. */
  listOpenTasksForUser(userId: string): Promise<TaskRecord[]>
  findTaskByMessage(waMessageId: string): Promise<TaskRecord | null>
  /** Open, assigned, non-approval tasks whose holder has not been sent a notice yet. */
  listUnnotifiedOpenTasks(): Promise<TaskRecord[]>
  /**
   * Creates a task. When subjectType/subjectId are set, a second live task with the
   * same (subjectType, subjectId, kind) is not created: the existing one is returned.
   */
  createTask(input: NewTask): Promise<TaskRecord>
  /** Sets status; 'done' stamps completedAt, any other status clears it. */
  updateTaskStatus(id: string, status: TaskStatus): Promise<TaskRecord | null>
  /** Sets status cancelled on the open (todo/doing) tasks about this subject. Returns how many. */
  cancelTasksForSubject(subjectType: string, subjectId: string): Promise<number>
  /** A new holder clears the notice and stamps assignedAt. */
  updateTaskAssignment(
    id: string,
    assignment: { assigneeId: string | null; assigneeRole: Role | null },
  ): Promise<TaskRecord | null>
  /**
   * Claims the right to send this task's notice: sets notifiedAt when the task is still held by
   * assigneeId and has no notice. Returns false when someone else got there first.
   */
  reserveTaskNotice(id: string, assigneeId: string): Promise<boolean>
  /** Undoes reserveTaskNotice after a failed send (only while no notice message is recorded). */
  releaseTaskNotice(id: string): Promise<void>
  /**
   * Frees notices reserved before `before` that never recorded a message (the sender died
   * mid-send), so they can be queued again. Returns how many.
   */
  releaseStaleTaskNotices(before: Date): Promise<number>
  markTaskNotified(id: string, waMessageId: string | null, at: Date): Promise<void>

  /** Returns null when a job with the same idempotencyKey already exists. */
  enqueueJob(job: NewJob): Promise<JobRecord | null>
  /**
   * Atomically claims up to `limit` queued jobs whose runAfter <= now, oldest first,
   * marking them running with lockedUntil = now + leaseMs and attempts + 1.
   * Postgres uses FOR UPDATE SKIP LOCKED so two workers never claim the same job.
   */
  claimJobs(limit: number, leaseMs: number, now: Date): Promise<JobRecord[]>
  completeJob(id: string): Promise<void>
  /** retryAt null marks the job failed for good; otherwise it is re-queued for retryAt. */
  failJob(id: string, error: string, retryAt: Date | null): Promise<void>
  /** Re-queues running jobs whose lease expired, or fails them when no attempts are left. Returns how many were re-queued. */
  requeueExpiredJobs(now: Date): Promise<number>
  /** Deletes done, failed and cancelled jobs last touched before `before`. Returns how many. */
  pruneJobs(before: Date): Promise<number>
  getJob(id: string): Promise<JobRecord | null>
}

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
  findAwaitingConfirmation(remoteJid: string): Promise<PendingConfirmation | null>
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
  /**
   * Creates a task. When subjectType/subjectId are set, a second live task with the
   * same (subjectType, subjectId, kind) is not created: the existing one is returned.
   */
  createTask(input: NewTask): Promise<TaskRecord>
  /** Sets status; 'done' stamps completedAt, any other status clears it. */
  updateTaskStatus(id: string, status: TaskStatus): Promise<TaskRecord | null>
  updateTaskAssignment(
    id: string,
    assignment: { assigneeId: string | null; assigneeRole: Role | null },
  ): Promise<TaskRecord | null>
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
  /** Re-queues running jobs whose lease expired. Returns how many. */
  requeueExpiredJobs(now: Date): Promise<number>
  getJob(id: string): Promise<JobRecord | null>
}

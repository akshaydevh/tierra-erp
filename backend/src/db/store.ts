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
  ClaimedMessage,
  AccountLink,
  ChatContext,
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
  WhatsappStatus,
} from './types'

export type RecentMessage = {
  /** The Evolution (or desk) message id. */
  id: string
  remoteJid: string
  fromMe: boolean
  body: string | null
  /** Why the bot sent it ('reply', 'agent_reply', 'approval_request' ...); null for inbound. */
  purpose: string | null
  createdAt: string
}

export type ThreadMessage = {
  id: string
  fromMe: boolean
  hasPdf: boolean
  body: string | null
  filename: string | null
  createdAt: string
  /** A desk turn whose reply is in (or that failed). */
  answeredAt: string | null
}

/** A PAN or card code that already belongs to another party group, or a party-group name already in use. */
export class PartyGroupConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PartyGroupConflictError'
  }
}

/** PANs are kept upper case; card codes as SAP spells them. Blank and repeated values are dropped. */
export function normalizeMembers(members: NewPartyGroup['members']): NewPartyGroup['members'] {
  const seen = new Set<string>()
  const out: NewPartyGroup['members'] = []
  for (const member of members) {
    const value = member.kind === 'pan' ? member.value.trim().toUpperCase() : member.value.trim()
    const key = `${member.kind}:${value}`
    if (!value || seen.has(key)) continue
    seen.add(key)
    out.push({ kind: member.kind, value })
  }
  return out
}

/** A live PO with this party, number and revision is already recorded (two copies arrived together). */
export class CustomerPoRevisionTakenError extends Error {
  constructor(poNo: string | null, revision: number) {
    super(`PO ${poNo ?? '(no number)'} revision ${revision} is already recorded`)
    this.name = 'CustomerPoRevisionTakenError'
  }
}

export type WaGroupPatch = { subject?: string | null; partyGroupId?: string | null; sendSo?: boolean }

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
  /** The last `limit` messages of these chats, oldest first. */
  listRecentMessages(remoteJids: string[], limit: number): Promise<RecentMessage[]>
  listThread(remoteJid: string): Promise<ThreadMessage[]>
  /** Stamps a desk turn as answered (its reply is in, or it failed): the desk stops waiting on it. */
  markMessageAnswered(evolutionMessageId: string, at: Date): Promise<void>
  releaseMessage(evolutionMessageId: string): Promise<void>
  /** True when a PDF from this WhatsApp message was already stored, so the message was already handled. */
  hasDocumentForMessage(messageId: string): Promise<boolean>
  insertDocument(input: StoredDocument & { messageId?: string | null } & Partial<DocumentLink>): Promise<string>
  getDocument(id: string): Promise<FetchedDocument | null>
  /** Says what a stored PDF is (a customer PO, a generated SO PDF ...) and which record it belongs to. */
  linkDocument(id: string, link: DocumentLink): Promise<void>

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
  /**
   * Opens a finished task again with a new title and description, as if newly assigned: its holder gets a fresh
   * notice. Null when there is no such task.
   */
  reopenTask(id: string, patch: { title: string; description: string | null }): Promise<TaskRecord | null>
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

  listPartyGroups(): Promise<PartyGroup[]>
  getPartyGroup(id: string): Promise<PartyGroup | null>
  /** Throws PartyGroupConflictError when the name or one of the PANs / card codes is already taken. */
  createPartyGroup(input: NewPartyGroup): Promise<PartyGroup>
  /** Replaces the name, alias and members. Null when there is no such group; conflicts throw as on create. */
  updatePartyGroup(id: string, input: NewPartyGroup): Promise<PartyGroup | null>
  /** Deletes the group and its members; WhatsApp groups mapped to it become unmapped. */
  deletePartyGroup(id: string): Promise<boolean>
  getWaGroup(jid: string): Promise<WaGroup | null>
  listWaGroups(): Promise<WaGroup[]>
  /** Inserts or updates a WhatsApp group; fields left out keep their value (new rows: unmapped, sendSo true). */
  saveWaGroup(jid: string, patch: WaGroupPatch): Promise<WaGroup>

  listCustomerSites(): Promise<CustomerSite[]>
  /** Item refs of one party group, or of all when partyGroupId is left out. */
  listCustomerItemRefs(partyGroupId?: string): Promise<CustomerItemRef[]>
  listItemOwnerOverrides(): Promise<ItemOwnerOverride[]>
  listPartyAliases(): Promise<PartyAlias[]>

  /**
   * Saves a received PO with its lines. The revision defaults to 1; a live row with the same party group, PO number
   * and revision makes this throw (the caller numbers a repeat as the next revision).
   */
  createCustomerPo(input: NewCustomerPo): Promise<CustomerPo>
  getCustomerPo(id: string): Promise<CustomerPo | null>
  findCustomerPoByMessage(messageId: string): Promise<CustomerPo | null>
  /** Live (not cancelled) POs with this number, newest first. */
  findCustomerPosByNumber(poNo: string): Promise<CustomerPo[]>
  /** Newest first, with the verdict of each PO's latest check. */
  listCustomerPos(filter?: { limit?: number; status?: string | null }): Promise<CustomerPoSummary[]>
  updateCustomerPo(id: string, patch: CustomerPoPatch): Promise<CustomerPo | null>
  /** Replaces the lines of a PO (the office's review: item codes confirmed, pieces worked out). */
  updateCustomerPoLines(id: string, lines: CustomerPoLine[]): Promise<CustomerPo | null>
  saveInventoryCheck(input: NewInventoryCheck): Promise<InventoryCheck>
  getInventoryCheck(id: string): Promise<InventoryCheck | null>
  latestInventoryCheck(customerPoId: string): Promise<InventoryCheck | null>
  /**
   * Tierra's own changes to SAP stock per item: pieces (and exploded components) reserved by TSOs in a reserving
   * status (RESERVING_SO_STATUSES: live and not in SAP yet) and active stock adjustments.
   */
  stockOverlays(itemCodes: readonly string[]): Promise<Record<string, StockOverlay>>

  /**
   * Raises a Tierra sales order with the next number of its series and financial year, in one transaction. A live
   * (not cancelled or rejected) TSO for the same customer PO is returned instead, with created false: a re-run job
   * never makes a second one or burns a number.
   */
  createSalesOrder(input: NewSalesOrder, numbering: { series: string; fy: string }): Promise<{ order: SalesOrder; created: boolean }>
  getSalesOrder(id: string): Promise<SalesOrder | null>
  findSalesOrderByNo(docNo: string): Promise<SalesOrder | null>
  /** The live TSO raised from this customer PO, if any. */
  findSalesOrderForPo(customerPoId: string): Promise<SalesOrder | null>
  listSalesOrders(filter?: { status?: SalesOrderStatus | null; limit?: number }): Promise<SalesOrder[]>
  /** Updates the TSO; with `from`, only while its status is one of those (returns null otherwise). */
  updateSalesOrder(id: string, patch: SalesOrderPatch, from?: readonly SalesOrderStatus[]): Promise<SalesOrder | null>

  /** One approval per subject and version; a second create returns the existing row. */
  createApproval(input: NewApproval): Promise<Approval>
  getApproval(id: string): Promise<Approval | null>
  listApprovals(filter?: { status?: ApprovalStatus | null; subjectType?: string; subjectId?: string; limit?: number }): Promise<Approval[]>
  /** The approval whose WhatsApp message this is (any of its waMessageIds). */
  findApprovalByMessage(waMessageId: string): Promise<Approval | null>
  /**
   * Conditional update: applies only while the row is still at `version` with status `from`. Null when someone got
   * there first (a second 👍, a send-back in between). This is the only way a decision is recorded.
   */
  transitionApproval(id: string, version: number, from: ApprovalStatus, patch: ApprovalPatch): Promise<Approval | null>
  /** Plain update for message ids, task and documents (not the decision). */
  updateApproval(id: string, patch: Pick<ApprovalPatch, 'waMessageIds' | 'taskId' | 'soPdfId' | 'annexId'>): Promise<Approval | null>

  /** Inserts the requests not already there (unique subject, item, reason); returns every request of the subject. */
  createProcurementRequests(rows: NewProcurementRequest[]): Promise<ProcurementRequest[]>
  listProcurementRequests(filter?: { subjectId?: string; status?: ProcurementStatus | null; limit?: number }): Promise<ProcurementRequest[]>
  /** Sets the status of the open requests of a subject (all, or one reason). Returns how many changed. */
  closeProcurementRequests(subjectId: string, status: ProcurementStatus, reason?: string): Promise<number>
  createStockAdjustment(input: NewStockAdjustment): Promise<StockAdjustment>
  listStockAdjustments(filter?: { status?: StockAdjustment['status'] | null; limit?: number }): Promise<StockAdjustment[]>
  getStockAdjustment(id: string): Promise<StockAdjustment | null>
  /** Stops an active adjustment counting (absorbed by a GRN or aged out, or cancelled). Null when it is not active. */
  closeStockAdjustment(id: string, status: 'absorbed' | 'cancelled', note: string, at: Date): Promise<StockAdjustment | null>

  /** Every stored PDF of a record, newest version first (no bytes). */
  listDocuments(subjectType: string, subjectId: string): Promise<DocumentInfo[]>

  /**
   * At-most-once outbound send: writes the registry row (status sending, a placeholder id) before the call. Returns
   * null when the row was written, or the existing row when this key was used before (never send again).
   */
  reserveOutbound(message: ClaimedMessage & { idempotencyKey: string; at?: Date }): Promise<OutboundRow | null>
  /** Records the real WhatsApp id after the send and marks the row sent. */
  completeOutbound(idempotencyKey: string, evolutionMessageId: string | null): Promise<void>
  setOutboundStatus(idempotencyKey: string, status: 'uncertain' | 'failed'): Promise<void>
  /** The registry row of an at-most-once send, if that key was ever used. */
  findOutbound(idempotencyKey: string): Promise<OutboundRow | null>

  /** Returns null when a job with the same idempotencyKey already exists. */
  enqueueJob(job: NewJob): Promise<JobRecord | null>
  /**
   * Atomically claims up to `limit` queued jobs whose runAfter <= now, oldest first,
   * marking them running with lockedUntil = now + leaseMs and attempts + 1.
   * Postgres uses FOR UPDATE SKIP LOCKED so two workers never claim the same job.
   * Turns of one chat run one at a time and in order: a wa.incoming job is only claimed when no other wa.incoming
   * job of the same chat is running or waiting ahead of it.
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
  findJobByKey(idempotencyKey: string): Promise<JobRecord | null>
  /** Cancels the jobs of a kind that have not started yet and whose payload contains these values. Returns how many. */
  cancelQueuedJobs(kind: string, payload: Record<string, string>): Promise<number>

  /** Payment labels per GL account for the daily report ("Gas"). */
  listGlLabels(): Promise<GlLabel[]>
  /** Bank journal lines moved to another report day. */
  listBankLineReattributions(): Promise<BankLineReattribution[]>
  getDailyInputs(reportDate: string): Promise<DailyReportInputs | null>
  /** Creates or updates a day's inputs: the fields in the patch change, the others keep their value. */
  saveDailyInputs(reportDate: string, patch: DailyInputsPatch, by: { userId: string | null; at: Date }): Promise<DailyReportInputs>
  /** Stores a generated report as the next version of its day. */
  createDailyReport(input: NewDailyReport): Promise<DailyReportRecord>
  latestDailyReport(reportDate: string): Promise<DailyReportRecord | null>
  /** A setting's JSON value, or null when it was never set. */
  getSetting(key: string): Promise<unknown>
  saveSetting(key: string, value: unknown, by: string | null): Promise<void>
}

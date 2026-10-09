export const ROLES = ['admin', 'manager', 'office'] as const
export type Role = (typeof ROLES)[number]

export function asRole(value: string): Role {
  if ((ROLES as readonly string[]).includes(value)) return value as Role
  throw new Error(`Unknown role ${value}`)
}

export function roleLabel(role: Role): string {
  if (role === 'admin') return 'Admin'
  if (role === 'manager') return 'Manager'
  return 'Office'
}

export const DESK_THREAD_PREFIX = 'desk:'

export type WhatsappStatus = 'disconnected' | 'qr_pending' | 'connected'

export const TASK_CATEGORIES = [
  'administration',
  'operations',
  'quality',
  'procurement',
  'production',
  'dispatch',
  'finance',
] as const

export type TaskCategory = (typeof TASK_CATEGORIES)[number]
export type TaskStatus = 'todo' | 'doing' | 'done' | 'cancelled'

export const TASK_KINDS = ['todo', 'procurement', 'approval', 'data_entry', 'customer_followup', 'review'] as const
export type TaskKind = (typeof TASK_KINDS)[number]

export const TASK_VIA = ['dashboard', 'whatsapp', 'desk', 'system'] as const
export type TaskVia = (typeof TASK_VIA)[number]

export function asTaskKind(value: string): TaskKind {
  if ((TASK_KINDS as readonly string[]).includes(value)) return value as TaskKind
  throw new Error(`Unknown task kind ${value}`)
}

export function asTaskVia(value: string): TaskVia {
  if ((TASK_VIA as readonly string[]).includes(value)) return value as TaskVia
  throw new Error(`Unknown task source ${value}`)
}

export function asTaskCategory(value: string): TaskCategory {
  if ((TASK_CATEGORIES as readonly string[]).includes(value)) return value as TaskCategory
  throw new Error(`Unknown task category ${value}`)
}

export function asTaskStatus(value: string): TaskStatus {
  if (value === 'todo' || value === 'doing' || value === 'done' || value === 'cancelled') return value
  throw new Error(`Unknown task status ${value}`)
}

export type TaskRecord = {
  id: string
  title: string
  category: TaskCategory
  status: TaskStatus
  kind: TaskKind
  assigneeId: string | null
  assigneeName: string | null
  /** The role the task is addressed to. The holder (assigneeId) is resolved from it. */
  assigneeRole: Role | null
  description: string | null
  dueAt: string | null
  subjectType: string | null
  subjectId: string | null
  notifiedAt: string | null
  /** Evolution message id of the WhatsApp notice for this task. */
  waMessageId: string | null
  createdVia: TaskVia
  createdBy: string
  createdByName: string | null
  createdAt: string
  completedAt: string | null
  /** When the current holder got the task; a new holder (or the same one again later) gets a new notice. */
  assignedAt: string
}

export type NewTask = {
  title: string
  category: TaskCategory
  kind?: TaskKind
  assigneeId: string | null
  assigneeRole?: Role | null
  description?: string | null
  dueAt?: Date | null
  subjectType?: string | null
  subjectId?: string | null
  createdVia?: TaskVia
  createdBy: string
}

export type User = {
  id: string
  email: string
  name: string
  role: Role
  passwordHash: string
}

export type PublicUser = {
  id: string
  email: string
  name: string
  role: Role
}

export type AccountLink = {
  id: string
  name: string
  email: string
  role: Role
  phoneNumber: string | null
}

export type WhatsappConnection = {
  instanceName: string
  status: WhatsappStatus
  qrBase64: string | null
  phoneNumber: string | null
}

export const MESSAGE_KINDS = ['text', 'document', 'image', 'reaction', 'other'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]
export type MessageStatus = 'received' | 'sending' | 'sent' | 'uncertain' | 'failed'

export type ClaimedMessage = {
  evolutionMessageId: string
  remoteJid: string
  fromMe: boolean
  hasPdf: boolean
  body: string | null
  senderJid?: string | null
  quotedId?: string | null
  kind?: MessageKind
  /** Why the bot sent it, e.g. 'reply', 'task_notice', 'test_pdf'. Null for inbound. */
  purpose?: string | null
  subjectType?: string | null
  subjectId?: string | null
  status?: MessageStatus | null
  idempotencyKey?: string | null
}

/** A row of the WhatsApp message registry, looked up by Evolution message id. */
export type StoredMessage = {
  evolutionMessageId: string
  remoteJid: string
  fromMe: boolean
  body: string | null
  kind: MessageKind
  purpose: string | null
  subjectType: string | null
  subjectId: string | null
  createdAt: string
}

export const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export type NewJob = {
  kind: string
  payload: Record<string, unknown>
  runAfter?: Date
  /** A second enqueue with the same key is dropped. */
  idempotencyKey?: string | null
  maxAttempts?: number
}

export type JobRecord = {
  id: string
  kind: string
  payload: Record<string, unknown>
  status: JobStatus
  attempts: number
  maxAttempts: number
  runAfter: string
  lockedUntil: string | null
  idempotencyKey: string | null
  lastError: string | null
}

export type ChatContext = {
  chatJid: string
  subjectType: string
  subjectId: string
  updatedAt: string
}

export type StoredDocument = {
  filename: string
  mimeType: string
  content: Buffer
}

/** A stored PDF as read back, with its kind: customer_po, so_pdf, so_annex, report (manager and admin only) ... */
export type FetchedDocument = StoredDocument & { kind: DocumentKind }

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

export const PARTY_MEMBER_KINDS = ['pan', 'card_code'] as const
export type PartyMemberKind = (typeof PARTY_MEMBER_KINDS)[number]

export type PartyMember = { kind: PartyMemberKind; value: string }

/** One customer as Tierra sees it. PANs cover every branch card of a company; card codes add single cards. */
export type PartyGroup = {
  id: string
  name: string
  alias: string | null
  members: PartyMember[]
}

export type NewPartyGroup = {
  name: string
  alias?: string | null
  members: PartyMember[]
}

export type WaGroup = {
  jid: string
  subject: string | null
  partyGroupId: string | null
  sendSo: boolean
  updatedAt: string
}

export const DOCUMENT_KINDS = ['customer_po', 'other', 'so_pdf', 'so_annex', 'report'] as const
export type DocumentKind = (typeof DOCUMENT_KINDS)[number]

/** Where a stored PDF belongs: a received customer PO, or (P4) a generated sales-order PDF and its version. */
export type DocumentLink = {
  kind: DocumentKind
  subjectType?: string | null
  subjectId?: string | null
  version?: number
}

/** A customer's delivery site (the code printed on its POs) and the SAP card that ships there. */
export type CustomerSite = {
  partyGroupId: string
  siteCode: string
  cardCode: string
  note: string | null
}

/** A customer's article / EAN for a Tierra item: the unit it orders in (CRT, C01 ...) and pieces in that unit. */
export type CustomerItemRef = {
  id: string
  partyGroupId: string
  articleNo: string | null
  ean: string | null
  itemCode: string
  buyerUom: string | null
  pcsPerUom: number | null
  lastPrice: number | null
  note: string | null
}

export type ItemOwnerOverride = {
  itemCode: string
  owner: 'tierra' | 'customer'
  ownerCardCode: string | null
  note: string | null
}

export type PartyAlias = { cardCode: string; alias: string }

/**
 * received: stored, not read yet. needs_review: the office must look (unreadable, customer or item not resolved).
 * awaiting_proceed: a repeat of a PO already in SAP or already received; the admin replies *proceed*.
 * short: checked and materials are short (P4 raises procurement). checked: passed and handed on (P4 raises the SO).
 */
export const CUSTOMER_PO_STATUSES = ['received', 'needs_review', 'awaiting_proceed', 'short', 'checked', 'cancelled'] as const
export type CustomerPoStatus = (typeof CUSTOMER_PO_STATUSES)[number]

export const CHECK_VERDICTS = ['pass', 'pass_with_incoming', 'fail'] as const
export type CheckVerdict = (typeof CHECK_VERDICTS)[number]

export type MatchMethod = 'article' | 'ean' | 'history' | 'name' | 'manual'
export type PcsSource = 'ea' | 'ref' | 'npu' | 'pcs'

export type CustomerPoLine = {
  lineNo: number
  articleNo: string | null
  ean: string | null
  description: string
  hsn: string | null
  qty: number
  uom: string | null
  /** The EA sub-row: the same quantity in pieces, when the PO prints it. */
  eaQty: number | null
  mrp: number | null
  /** Base cost per buyer unit (per carton for a CRT line). */
  baseCost: number | null
  gstPct: number | null
  /** All tax on the line as the PO prints it (GST and any cess). */
  taxAmount: number | null
  /** Total base value of the line, before tax. */
  lineTotal: number | null
  deliveryDate: string | null
  /** Cess on the line (percentage and fixed), when the PO prints it; part of taxAmount. */
  cessAmount?: number | null
  itemCode: string | null
  itemName: string | null
  matchMethod: MatchMethod | null
  /** False for a name-only match: someone has to confirm it. */
  matchConfirmed: boolean
  pcs: number | null
  pcsSource: PcsSource | null
  pcsPerUom: number | null
  /** Price per piece, 4 decimals, so the SO matches the PO to the paisa. */
  unitPrice: number | null
  note: string | null
}

/** A document that already carries this PO number: a SAP sales order or an earlier receipt here. */
export type RepeatHit = {
  source: 'sap' | 'tierra'
  docNo: string
  docDate: string | null
  cardCode: string | null
  status: string
  invoices: string[]
  customerPoId?: string
}

export type NewCustomerPo = {
  partyGroupId: string | null
  poNo: string | null
  revision?: number
  status: CustomerPoStatus
  cardCode: string | null
  siteCode: string | null
  shipToGstin: string | null
  shipToAddress: string | null
  buyerName: string | null
  vendorCode: string | null
  poDate: string | null
  deliveryDate: string | null
  basicTotal: number | null
  taxTotal: number | null
  total: number | null
  notes: string[]
  /** As printed on the PO, e.g. "DDP - Delivered Duty Paid". */
  deliveryTerm?: string | null
  paymentTerms?: string | null
  reader: string | null
  resolution: Record<string, unknown> | null
  reviewReason: string | null
  repeatOf: RepeatHit[]
  documentId: string | null
  sourceChat: string | null
  sourceMessageId: string | null
  sourceSender: string | null
  raisedBy: string | null
  lines: CustomerPoLine[]
}

export type CustomerPo = Omit<NewCustomerPo, 'revision'> & {
  id: string
  revision: number
  partyName: string | null
  createdAt: string
  updatedAt: string
}

export type CustomerPoSummary = {
  id: string
  poNo: string | null
  revision: number
  status: CustomerPoStatus
  partyGroupId: string | null
  partyName: string | null
  cardCode: string | null
  siteCode: string | null
  poDate: string | null
  deliveryDate: string | null
  total: number | null
  lineCount: number
  verdict: CheckVerdict | null
  repeat: boolean
  reviewReason: string | null
  sourceChat: string | null
  createdAt: string
}

export type CustomerPoPatch = Partial<
  Pick<NewCustomerPo, 'status' | 'partyGroupId' | 'cardCode' | 'reviewReason' | 'resolution' | 'repeatOf' | 'revision'>
>

export type CheckLineStatus = 'ok' | 'short_now' | 'short'
export type ItemOwner = 'tierra' | 'customer' | 'customer_unknown'

export type InventoryCheckLine = {
  kind: 'fg' | 'component'
  itemCode: string
  itemName: string | null
  /** laminate, carton, seasoning, raw_banana, oil, tape, consumable ... (fg for finished goods) */
  role: string | null
  uom: string | null
  need: number
  onHand: number
  committed: number
  /** Held by open / approved Tierra sales orders (P4). */
  reserved: number
  /** Active stock adjustments not yet in SAP (P4). */
  adjustments: number
  free: number
  onOrder: number
  shortNow: number
  shortAfterIncoming: number
  /** Finished goods: pieces served from stock and pieces to make. */
  fromStock: number | null
  toMake: number | null
  owner: ItemOwner | null
  ownerCardCode: string | null
  ownerName: string | null
  /** False for warning-only materials (tape, LPG, ribbon): they never decide the verdict. */
  checked: boolean
  /** The quantity is a fallback (placeholder BOM line, 90-day usage), not the BOM itself. */
  estimated: boolean
  status: CheckLineStatus
  /** Open purchase orders bringing it in, e.g. PO/26-27/112. */
  incoming: string[]
  /** The finished goods that need this component. */
  forItems: string[]
  note: string | null
}

export type NewInventoryCheck = {
  customerPoId: string | null
  kind: 'po' | 'dry_run'
  verdict: CheckVerdict
  dataAsOf: string | null
  warnings: string[]
  /** What was asked: item code and pieces per line. */
  requested: Array<{ itemCode: string; pcs: number }>
  createdBy: string | null
  lines: InventoryCheckLine[]
}

export type InventoryCheck = NewInventoryCheck & { id: string; createdAt: string }

/** Tierra-side changes to SAP stock: pieces held by open TSOs and unposted receipts (P4 fills both). */
export type StockOverlay = { reserved: number; adjustments: number }

// ------------------------------------------------------------------------------------------------ P4: sales orders

/**
 * A Tierra sales order (TSO/26-27/0001) raised from a checked customer PO.
 * draft: being revised after a send-back. pending_approval: waiting for the admin. approved: the admin said yes, the
 * customer copy goes to the group after the 60 s window. approved_unsent: approved, but the bot sent nothing to the
 * customer (no group mapped, sales orders switched off, or a send it could not confirm): the office sends it by hand.
 * sent: the customer copy is in the group. in_sap: the office keyed it into SAP, whose open SO now holds the stock.
 * rejected / cancelled: dead; reservations released.
 */
export const SALES_ORDER_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'approved_unsent',
  'sent',
  'in_sap',
  'rejected',
  'cancelled',
] as const
export type SalesOrderStatus = (typeof SALES_ORDER_STATUSES)[number]
/**
 * Statuses that hold stock: every live TSO until it is linked to its SAP sales order (D14). From then on SAP's open
 * SO commits the pieces, so the TSO would count them twice. Rejected and cancelled TSOs never reserve.
 */
export const RESERVING_SO_STATUSES: readonly SalesOrderStatus[] = ['draft', 'pending_approval', 'approved', 'approved_unsent', 'sent']
/** Statuses an admin can still cancel (anything not dead and not keyed into SAP yet). */
export const CANCELLABLE_SO_STATUSES: readonly SalesOrderStatus[] = RESERVING_SO_STATUSES

export type TaxKind = 'cgst_sgst' | 'igst'

export type SalesOrderLine = {
  lineNo: number
  itemCode: string
  itemName: string | null
  /** As the customer printed it on the PO. */
  description: string | null
  articleNo: string | null
  ean: string | null
  /** From SAP (OITM.ChapterID -> OCHP); what the SO prints. */
  hsn: string | null
  /** As the PO printed it; a different value is an internal warning only. */
  poHsn: string | null
  /** The buyer's unit (CRT, C01, EA) and quantity in it. */
  uom: string | null
  qty: number
  pcs: number
  pcsPerUom: number | null
  /** Cartons ("No of Boxes"). */
  cartons: number | null
  /** MRP per piece. */
  mrp: number | null
  /** Price per piece, 4 decimals, so the total matches the PO to the paisa. */
  unitPrice: number
  /** Taxable value of the line (the PO's base value). */
  amount: number
  gstPct: number
  /** GST on the line (CGST + SGST, or IGST); cess is separate. */
  taxAmount: number
  /** Cess on the line, as the PO printed it. */
  cessAmount?: number
  /** Finished pieces taken from free stock (held while the TSO is open). */
  reservedPcs: number
  toMake: number
}

export type NewSalesOrder = {
  customerPoId: string | null
  partyGroupId: string | null
  cardCode: string
  checkId: string | null
  status: SalesOrderStatus
  docDate: string
  deliveryDate: string | null
  customerPoNo: string | null
  poDate: string | null
  vendorCode: string | null
  siteCode: string | null
  shipToGstin: string | null
  placeOfSupply: string | null
  stateCode: string | null
  taxKind: TaxKind
  basicTotal: number
  cgst: number
  sgst: number
  igst: number
  /** Cess, carried from the PO so the TSO adds up to it. Part of taxTotal. */
  cess?: number
  taxTotal: number
  total: number
  deliveryTerm: string | null
  paymentTerms: string | null
  notes: string[]
  createdBy: string | null
  lines: SalesOrderLine[]
}

export type SalesOrder = NewSalesOrder & {
  id: string
  docNo: string
  series: string
  fy: string
  seq: number
  version: number
  approvedBy: string | null
  approvedAt: string | null
  sentAt: string | null
  cess: number
  /** The SAP sales order the office keyed for it (status in_sap). */
  sapDocEntry: number | null
  sapDocNo: string | null
  cancelledAt: string | null
  partyName: string | null
  createdAt: string
  updatedAt: string
}

export type SalesOrderPatch = Partial<
  Pick<SalesOrder, 'status' | 'version' | 'approvedBy' | 'approvedAt' | 'sentAt' | 'sapDocEntry' | 'sapDocNo' | 'cancelledAt'>
>

export const APPROVAL_STATUSES = ['pending', 'approved', 'sent_back', 'rejected', 'superseded'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]
export type ApprovalVia = 'reaction' | 'reply' | 'text' | 'llm' | 'desk'

/** One approval request per PDF version of a subject (a TSO). A send-back makes the next version a new row. */
export type Approval = {
  id: string
  subjectType: string
  subjectId: string
  version: number
  approverRole: Role
  status: ApprovalStatus
  channel: 'whatsapp' | 'desk' | null
  via: ApprovalVia | null
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: string | null
  note: string | null
  /** The approver also raised it (forwarded the PO); allowed, but flagged. */
  selfRaised: boolean
  raisedBy: string | null
  /** WhatsApp ids of the approval message(s); a 👍 on any of them is an approval. */
  waMessageIds: string[]
  taskId: string | null
  soPdfId: string | null
  annexId: string | null
  createdAt: string
  updatedAt: string
}

export type NewApproval = Pick<Approval, 'subjectType' | 'subjectId' | 'version' | 'approverRole' | 'selfRaised' | 'raisedBy'> &
  Partial<Pick<Approval, 'soPdfId' | 'annexId'>>

export type ApprovalPatch = Partial<
  Pick<Approval, 'status' | 'channel' | 'via' | 'decidedBy' | 'decidedAt' | 'note' | 'waMessageIds' | 'taskId' | 'soPdfId' | 'annexId'>
>

export const PROCUREMENT_REASONS = ['production', 'expedite', 'shortage'] as const
export type ProcurementReason = (typeof PROCUREMENT_REASONS)[number]
export type ProcurementStatus = 'open' | 'done' | 'cancelled'

/** Something to buy, expedite or make for an order. Customer-supplied shortages are never purchased (a follow-up task). */
export type ProcurementRequest = {
  id: string
  subjectType: string
  subjectId: string
  customerPoId: string | null
  salesOrderId: string | null
  itemCode: string
  itemName: string | null
  qty: number
  uom: string | null
  reason: ProcurementReason
  status: ProcurementStatus
  taskId: string | null
  note: string | null
  createdAt: string
}

export type NewProcurementRequest = Omit<ProcurementRequest, 'id' | 'status' | 'createdAt'>

/** A receipt (or correction) Tierra knows about before SAP does: "received 20 kg ZPMLMA". Shown as unposted. */
export type StockAdjustment = {
  id: string
  itemCode: string
  qty: number
  uom: string | null
  reason: string
  note: string | null
  taskId: string | null
  createdBy: string | null
  createdByName: string | null
  createdVia: TaskVia
  status: 'active' | 'absorbed' | 'cancelled'
  effectiveAt: string
  createdAt: string
  /** When it stopped counting, and why (the GRN that absorbed it, aged out, cancelled by ...). */
  closedAt: string | null
  closedNote: string | null
}

export type NewStockAdjustment = Pick<StockAdjustment, 'itemCode' | 'qty' | 'uom' | 'reason' | 'note' | 'taskId' | 'createdBy' | 'createdVia'>

/** A stored PDF as a list row (no bytes). */
export type DocumentInfo = {
  id: string
  filename: string
  kind: DocumentKind
  subjectType: string | null
  subjectId: string | null
  version: number
  createdAt: string
}

/** The registry row of an at-most-once outbound send (customer-group copies). */
export type OutboundRow = {
  idempotencyKey: string
  evolutionMessageId: string
  status: MessageStatus | null
  remoteJid: string
  createdAt: string
}

// ------------------------------------------------------------------------------------------------ P6: daily report

/** Role names people use that are not roles of their own: QA enters the daily inputs, a job the office holds (D13). */
export const ROLE_ALIASES: Readonly<Record<string, Role>> = { qa: 'office' }

/** A role, or a role alias ("qa"), as the role it routes to; null for anything else. */
export function roleFromName(name: string): Role | null {
  const value = name.trim().toLowerCase()
  if ((ROLES as readonly string[]).includes(value)) return value as Role
  return ROLE_ALIASES[value] ?? null
}

/** Who enters the daily report's inputs (manpower, banana estimate): the office (and its QA alias) and the admin. */
export const DAILY_INPUT_ROLES: readonly Role[] = ['office', 'admin']
/** Who reads finance: the daily report, bank balances, payments, receivables and payables. */
export const FINANCE_ROLES: readonly Role[] = ['manager', 'admin']
/** Payroll, attendance and leave (P7): the admin only, on every surface (routes, nav, agent tools, WhatsApp). */
export const PAYROLL_ROLES: readonly Role[] = ['admin']

/** The manual sheet's manpower row, in its order. */
export const MANPOWER_KEYS = ['office', 'qc', 'operators', 'gents_unloading', 'ladies', 'temp_ladies', 'security', 'temporary'] as const
export type ManpowerKey = (typeof MANPOWER_KEYS)[number]
export type Manpower = Record<ManpowerKey, number>

export const MANPOWER_LABELS: Record<ManpowerKey, string> = {
  office: 'Office',
  qc: 'QC',
  operators: 'Operators',
  gents_unloading: 'Gents (unloading)',
  ladies: 'Ladies',
  temp_ladies: 'Temporary ladies',
  security: 'Security',
  temporary: 'Temporary',
}

/**
 * Which invoices count as a day's outwards: created_window (keyed between the previous evening's cut-off and this
 * evening's, the way the manual sheet is made), doc_date (the invoice date), ewb_date (the e-way bill's date).
 */
export const OUTWARDS_BASES = ['created_window', 'doc_date', 'ewb_date'] as const
export type OutwardsBasis = (typeof OUTWARDS_BASES)[number]

export type DailyReportInputs = {
  reportDate: string
  /** Null: take it from SAP (production orders, receipts and issues of the day). */
  productionRun: boolean | null
  packingRun: boolean | null
  cartoningRun: boolean | null
  manpower: Manpower | null
  bananaKgEstimate: number | null
  cassavaKgEstimate: number | null
  /** Free text per inward item row ("banana": "2 loads short"). */
  inwardRemarks: Record<string, string>
  notes: string | null
  enteredBy: string | null
  enteredByName: string | null
  enteredAt: string | null
}

/** Fields to change; a field left out keeps its value, null clears it. */
export type DailyInputsPatch = Partial<
  Pick<
    DailyReportInputs,
    'productionRun' | 'packingRun' | 'cartoningRun' | 'manpower' | 'bananaKgEstimate' | 'cassavaKgEstimate' | 'inwardRemarks' | 'notes'
  >
>

export type GlLabel = { glCode: string; label: string; preferPayee: boolean }

export type BankLineReattribution = { transId: number; lineId: number; reportDate: string; note: string | null }

export type DailyReportRecord = {
  id: string
  reportDate: string
  version: number
  basis: OutwardsBasis
  dataAsOf: string | null
  payload: unknown
  documentId: string | null
  generatedBy: string | null
  createdAt: string
}

export type NewDailyReport = Pick<DailyReportRecord, 'reportDate' | 'basis' | 'dataAsOf' | 'payload' | 'documentId' | 'generatedBy'>

export function asOutwardsBasis(value: unknown): OutwardsBasis | null {
  return (OUTWARDS_BASES as readonly unknown[]).includes(value) ? (value as OutwardsBasis) : null
}

export const ROLES = ['admin', 'manager', 'office'] as const
export type Role = (typeof ROLES)[number]

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Admin',
  manager: 'Manager',
  office: 'Office',
}

export function roleLabel(role: Role): string {
  return ROLE_LABELS[role]
}

export type Me = {
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

export type RoleHolder = { id: string; name: string }

/** Who holds each role right now, as the backend resolves it for routing. */
export type RoleHolders = Record<Role, RoleHolder | null>

export type WhatsappConnection = {
  instanceName: string
  status: 'disconnected' | 'qr_pending' | 'connected'
  qrBase64: string | null
  phoneNumber: string | null
}

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
export type TaskKind = 'todo' | 'procurement' | 'approval' | 'data_entry' | 'customer_followup' | 'review'
export type TaskVia = 'dashboard' | 'whatsapp' | 'desk' | 'system'

export type Task = {
  id: string
  title: string
  category: TaskCategory
  status: TaskStatus
  kind: TaskKind
  assigneeId: string | null
  assigneeName: string | null
  assigneeRole: Role | null
  description: string | null
  dueAt: string | null
  subjectType: string | null
  subjectId: string | null
  notifiedAt: string | null
  waMessageId: string | null
  createdVia: TaskVia
  createdBy: string
  createdByName: string | null
  createdAt: string
  completedAt: string | null
  /** When the current holder got the task. */
  assignedAt?: string
}

export const TASK_KIND_LABELS: Record<TaskKind, string> = {
  todo: 'To do',
  procurement: 'Procurement',
  approval: 'Approval',
  data_entry: 'Data entry',
  customer_followup: 'Customer follow-up',
  review: 'Review',
}

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  administration: 'Administration',
  operations: 'Operations',
  quality: 'Quality',
  procurement: 'Procurement',
  production: 'Production',
  dispatch: 'Dispatch',
  finance: 'Finance',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: 'To do',
  doing: 'In progress',
  done: 'Done',
  cancelled: 'Cancelled',
}

// ---- SAP read model (P1). Shapes mirror the backend routes over the `erp` views:
// numbers are JS numbers, dates `YYYY-MM-DD`, timestamps ISO strings.

/** `GET /api/meta`; every field is null until the first SAP import. */
export type Meta = {
  dataAsOf: string | null
  importedAt: string | null
  backup: string | null
}

export type Paged<T> = {
  rows: T[]
  total: number
  page: number
  pageSize: number
}

export const MATERIAL_ROLES = [
  'fg',
  'laminate',
  'carton',
  'seasoning',
  'raw_banana',
  'raw_cassava',
  'oil',
  'tape',
  'consumable',
  'overhead',
  'other',
] as const
export type MaterialRole = (typeof MATERIAL_ROLES)[number]

export const MATERIAL_ROLE_LABELS: Record<MaterialRole, string> = {
  fg: 'Finished goods',
  laminate: 'Laminate',
  carton: 'Carton',
  seasoning: 'Seasoning',
  raw_banana: 'Raw banana',
  raw_cassava: 'Raw cassava',
  oil: 'Oil',
  tape: 'Tape',
  consumable: 'Consumable',
  overhead: 'Overhead',
  other: 'Other',
}

export function materialRoleLabel(role: string | null | undefined): string {
  if (!role) return '—'
  return MATERIAL_ROLE_LABELS[role as MaterialRole] ?? role
}

// Command Centre -------------------------------------------------------------

export type CommandCentre = {
  dataAsOf: string | null
  kpis: {
    openSalesOrders: number
    staleOpenSalesOrders: number
    salesMtdValue: number
    salesMtdCount: number
    invoicesLastDay: number
    fgShortItems: number
  }
  whatsapp: { status: WhatsappConnection['status']; phoneNumber: string | null }
  recentSalesOrders: SalesOrderRow[]
}

// Inventory --------------------------------------------------------------------

export const INVENTORY_TABS = ['fg', 'materials'] as const
export type InventoryTab = (typeof INVENTORY_TABS)[number]

export type StockRow = {
  itemCode: string
  itemName: string
  materialRole: MaterialRole | null
  uom: string | null
  uomInferred: boolean
  whsCode: string
  onHand: number
  committed: number
  free: number
  onOrder: number
  value: number | null
  ownerName: string | null
  customerSupplied: boolean
}

export type InventoryResponse = Paged<StockRow> & {
  kpis: {
    fgItems: number
    fgShort: number
    materialsBelowZero: number
    customerSuppliedItems: number
  }
  roleCounts: Partial<Record<MaterialRole, number>>
}

// Sales orders -----------------------------------------------------------------

export const ORDER_TABS = ['book', 'customer-pos', 'intake', 'tso'] as const
export type OrderTab = (typeof ORDER_TABS)[number]

export const ORDER_STATES = ['all', 'open', 'closed', 'cancelled'] as const
export type OrderState = (typeof ORDER_STATES)[number]

export type SalesOrderStatus = 'open' | 'closed' | 'cancelled'

export type SalesOrderRow = {
  docEntry: number
  docNo: string
  docDate: string
  dueDate: string | null
  cardCode: string
  cardName: string
  customerPoNo: string | null
  total: number
  status: SalesOrderStatus
  stale: boolean
  lineCount: number
  totalQty: number
  invoiceCount: number
}

export type CustomerPoRow = {
  customerPoNo: string
  /** The customer's PAN, or its card code without a GSTIN; with customerPoNo it names one PO. */
  partyKey: string
  cardName: string
  cardCodes: string[]
  salesOrderCount: number
  firstDate: string
  lastDate: string
  total: number
  openCount: number
}

export type OrdersKpis = {
  open: number
  stale: number
  valueMtd: number
  poCount: number
}

export type OrderBookResponse = Paged<SalesOrderRow> & { kpis: OrdersKpis }
export type CustomerPosResponse = Paged<CustomerPoRow> & { kpis: OrdersKpis }

export type SalesOrderDetail = SalesOrderRow & {
  poDate: string | null
  shipToCode: string | null
  taxTotal: number
  approvalStatus: string | null
  createdBy: string | null
}

/** One RDR1 line, from `erp.sales_order_lines`. */
export type SalesOrderLine = {
  lineNum: number
  itemCode: string
  itemName: string
  qty: number
  openQty: number
  price: number
  lineTotal: number
  taxCode: string | null
  taxPct: number | null
  whsCode: string | null
  lineStatus: string | null
  invoiceDocEntry: number | null
}

/** One approval step, from `erp.approvals_hist`. */
export type ApprovalRow = {
  docObject: string
  docEntry: number | null
  draftEntry: number | null
  docNo: string | null
  status: 'approved' | 'rejected' | 'waiting'
  originator: string | null
  approver: string | null
  requestedAt: string | null
  decidedAt: string | null
  total: number | null
}

export type SalesOrderResponse = {
  order: SalesOrderDetail
  lines: SalesOrderLine[]
  invoices: InvoiceRow[]
  approvals: ApprovalRow[]
}

// Dispatch ---------------------------------------------------------------------

export type InvoiceRow = {
  docEntry: number
  docNo: string
  docDate: string
  createdAt: string | null
  cardName: string
  customerPoNo: string | null
  total: number
  ewbNo: string | null
  ewbAt: string | null
  /** The e-way bill shown was cancelled; the invoice has no live one. */
  ewbCancelled: boolean
  irnStatus: string | null
  ackNo: string | null
  soDocEntries: number[]
}

export type DispatchResponse = {
  date: string | null
  kpis: {
    invoices: number
    value: number
    ewaybills: number
    irnFailures: number
  }
  rows: InvoiceRow[]
}

// Production -------------------------------------------------------------------

export const PRODUCTION_STATUSES = ['planned', 'released', 'closed', 'cancelled'] as const
export type ProductionStatus = (typeof PRODUCTION_STATUSES)[number]

export type ProductionRow = {
  docEntry: number
  docNo: string
  docNum: number
  itemCode: string
  itemName: string
  type: 'standard' | 'disassembly'
  status: ProductionStatus
  plannedQty: number
  completedQty: number
  postDate: string | null
  startDate: string | null
  dueDate: string | null
  closeDate: string | null
  cardCode: string | null
  customerName: string | null
  stockType: string | null
  issuedValue: number | null
  receivedValue: number | null
  comments: string | null
}

export type ProductionResponse = Paged<ProductionRow> & {
  kpis: {
    openOrders: number
    completedMtdQty: number
    ordersMtd: number
    disassemblyMtd: number
  }
}

/** One WOR1 line, from `erp.production_components`. */
export type ProductionComponent = {
  lineNum: number
  itemCode: string
  itemName: string
  materialRole: MaterialRole | null
  plannedQty: number
  issuedQty: number
  uom: string | null
  issueMethod: string | null
  issuedValue?: number | null
}

export type ProductionOrderResponse = {
  order: ProductionRow
  components: ProductionComponent[]
}

// Procurement ------------------------------------------------------------------

export const PROCUREMENT_TABS = ['pos', 'grns', 'requests', 'adjustments'] as const
export type ProcurementTab = (typeof PROCUREMENT_TABS)[number]

export type PurchaseOrderRow = {
  docEntry: number
  docNo: string
  docDate: string
  cardName: string
  total: number
  openValue: number
  status: string
  lineCount: number
  lineSummary: string | null
}

export type GrnRow = {
  docEntry: number
  docNo: string
  docDate: string
  cardName: string
  total: number
  freeIssue: boolean
  lineSummary: string | null
}

export type ProcurementKpis = {
  openPos: number
  openPoValue: number
  grnsMtd: number
  freeIssueGrnsMtd: number
}

export type PurchaseOrdersResponse = Paged<PurchaseOrderRow> & { kpis: ProcurementKpis }
export type GrnsResponse = Paged<GrnRow> & { kpis: ProcurementKpis }

// Pickers (`GET /api/items?q=`, `GET /api/parties?q=`, top 50) ---------------------

/** From `erp.items`. */
export type ItemRow = {
  itemCode: string
  itemName: string
  groupCode: number | null
  groupName: string | null
  category: string | null
  materialRole: MaterialRole | null
  uomRaw: string | null
  uom: string | null
  uomInferred: boolean
  pcsPerCarton: number | null
  packGrams: number | null
  gstRate: number | null
  batchManaged: boolean
  hasBom: boolean
  active: boolean
}

/** From `erp.parties`. */
export type PartyRow = {
  cardCode: string
  cardName: string
  cardType: 'customer' | 'supplier'
  groupName: string | null
  pan: string | null
  gstin: string | null
  city: string | null
  state: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  /** Manager and admin only. */
  balance?: number | null
  active: boolean
}

export type ItemsResponse = { rows: ItemRow[] }
export type PartiesResponse = { rows: PartyRow[] }

// PO intake (P3) ---------------------------------------------------------------

export type PartyMember = { kind: 'pan' | 'card_code'; value: string; name?: string | null }

export type CustomerSite = { partyGroupId: string; siteCode: string; cardCode: string; cardName?: string | null; note: string | null }

export type CustomerItemRef = {
  id: string
  partyGroupId: string
  articleNo: string | null
  ean: string | null
  itemCode: string
  buyerUom: string | null
  pcsPerUom: number | null
}

export type PartyGroup = {
  id: string
  name: string
  alias: string | null
  members: PartyMember[]
  sites?: CustomerSite[]
  itemRefs?: CustomerItemRef[]
}

export type WaGroupRow = {
  id: string
  subject: string
  size: number | null
  partyGroupId: string | null
  sendSo: boolean
  /** The bot is in the group now (false: only known from earlier messages; null: the gateway is down). */
  inGroup: boolean | null
}

export type CustomerPoStatus = 'received' | 'needs_review' | 'awaiting_proceed' | 'short' | 'checked' | 'cancelled'
export type CheckVerdict = 'pass' | 'pass_with_incoming' | 'fail'

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

export type CustomerPoLine = {
  lineNo: number
  articleNo: string | null
  ean: string | null
  description: string
  hsn: string | null
  qty: number
  uom: string | null
  eaQty: number | null
  mrp: number | null
  baseCost: number | null
  gstPct: number | null
  taxAmount: number | null
  lineTotal: number | null
  deliveryDate: string | null
  itemCode: string | null
  itemName: string | null
  matchMethod: 'article' | 'ean' | 'history' | 'name' | 'manual' | null
  matchConfirmed: boolean
  pcs: number | null
  pcsSource: 'ea' | 'ref' | 'npu' | 'pcs' | null
  pcsPerUom: number | null
  unitPrice: number | null
  note: string | null
}

export type RepeatHit = {
  source: 'sap' | 'tierra'
  docNo: string
  docDate: string | null
  cardCode: string | null
  status: string
  invoices: string[]
  customerPoId?: string
}

export type CustomerPo = {
  id: string
  partyGroupId: string | null
  partyName: string | null
  poNo: string | null
  revision: number
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
  reader: string | null
  resolution: { method?: string; note?: string; reason?: string; candidates?: string[] } | null
  reviewReason: string | null
  repeatOf: RepeatHit[]
  documentId: string | null
  sourceChat: string | null
  sourceSender: string | null
  /** The Tierra account that sent it; null for an unknown number or a customer group. */
  raisedBy: string | null
  createdAt: string
  lines: CustomerPoLine[]
}

export type CheckLine = {
  kind: 'fg' | 'component'
  itemCode: string
  itemName: string | null
  role: string | null
  uom: string | null
  need: number
  onHand: number
  committed: number
  reserved: number
  adjustments: number
  free: number
  onOrder: number
  shortNow: number
  shortAfterIncoming: number
  fromStock: number | null
  toMake: number | null
  owner: 'tierra' | 'customer' | 'customer_unknown' | null
  ownerCardCode: string | null
  ownerName: string | null
  checked: boolean
  estimated: boolean
  status: 'ok' | 'short_now' | 'short'
  incoming: string[]
  forItems: string[]
  note: string | null
}

export type InventoryCheck = {
  id: string
  verdict: CheckVerdict
  dataAsOf: string | null
  warnings: string[]
  createdAt: string
  lines: CheckLine[]
}

export type CustomerPoResponse = {
  /** The live Tierra sales order raised from this PO, if any. */
  salesOrder: TsoSummary | null
  po: CustomerPo
  cardName: string | null
  check: InventoryCheck | null
  document: { id: string; filename: string } | null
  tasks: Task[]
}

// Tierra sales orders, approvals and procurement requests (P4) -----------------
// Tierra's own sales orders (TSO/26-27/0001) are a different record from SAP's
// sales orders above, hence the Tso prefix.

/**
 * approved_unsent: approved, but nothing went to the customer (no group, sales orders off, or a send nobody could
 * confirm). in_sap: the office keyed it into SAP; SAP's SO holds the stock from then on.
 */
export type TsoStatus = 'draft' | 'pending_approval' | 'approved' | 'approved_unsent' | 'sent' | 'in_sap' | 'rejected' | 'cancelled'
/** A TSO the admin can still cancel: live and not in SAP yet. */
export const CANCELLABLE_TSO: readonly TsoStatus[] = ['draft', 'pending_approval', 'approved', 'approved_unsent', 'sent']
export type TaxKind = 'cgst_sgst' | 'igst'

export type TsoLine = {
  lineNo: number
  itemCode: string
  itemName: string | null
  /** As the customer printed it on the PO. */
  description: string | null
  articleNo: string | null
  ean: string | null
  /** From SAP; what the SO prints. */
  hsn: string | null
  /** As the PO printed it; a different value is an internal warning only. */
  poHsn: string | null
  uom: string | null
  qty: number
  pcs: number
  pcsPerUom: number | null
  /** Cartons ("No of Boxes"). */
  cartons: number | null
  mrp: number | null
  /** Price per piece, 4 decimals. */
  unitPrice: number
  /** Taxable value of the line. */
  amount: number
  gstPct: number
  taxAmount: number
  /** Cess carried from the PO. */
  cessAmount?: number
  /** Finished pieces taken from free stock (held while the TSO is open). */
  reservedPcs: number
  toMake: number
}

export type Tso = {
  id: string
  docNo: string
  series: string
  fy: string
  seq: number
  version: number
  customerPoId: string | null
  partyGroupId: string | null
  cardCode: string
  checkId: string | null
  status: TsoStatus
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
  /** Cess carried from the PO; part of taxTotal. */
  cess: number
  taxTotal: number
  total: number
  deliveryTerm: string | null
  paymentTerms: string | null
  notes: string[]
  createdBy: string | null
  approvedBy: string | null
  approvedAt: string | null
  sentAt: string | null
  /** The SAP sales order the office keyed for it (status in_sap). */
  sapDocEntry: number | null
  sapDocNo: string | null
  cancelledAt: string | null
  partyName: string | null
  createdAt: string
  updatedAt: string
  lines: TsoLine[]
}

/** `GET /api/sales-orders` rows and `ApprovalView.order`. */
export type TsoSummary = {
  id: string
  docNo: string
  status: TsoStatus
  version: number
  partyName: string | null
  cardCode: string
  customerPoNo: string | null
  customerPoId: string | null
  docDate: string
  deliveryDate: string | null
  total: number
  lineCount: number
  pcs: number
  approvedAt: string | null
  sentAt: string | null
  createdAt: string
}

export type ApprovalStatus = 'pending' | 'approved' | 'sent_back' | 'rejected' | 'superseded'
export type ApprovalVia = 'reaction' | 'reply' | 'text' | 'llm' | 'desk'

/** One approval request per PDF version of a TSO. */
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
  taskId: string | null
  soPdfId: string | null
  annexId: string | null
  createdAt: string
  updatedAt: string
}

/** An approval as the dashboard shows it, with its TSO and the check verdict. */
export type ApprovalView = Approval & {
  waMessages: number
  verdict: CheckVerdict | null
  order: TsoSummary | null
}

/** SAP's own decided approvals, from `erp.approvals_hist`. */
export type ApprovalHistoryRow = {
  docObject: string
  docType: string | null
  docNo: string | null
  cardName: string | null
  status: 'approved' | 'rejected' | 'waiting'
  originator: string | null
  approver: string | null
  requestedAt: string | null
  decidedAt: string | null
  total: number | null
  template: string | null
  remarks: string | null
}

export type ApprovalsResponse = {
  canDecide: boolean
  pending: ApprovalView[]
  decided: ApprovalView[]
  sap: Paged<ApprovalHistoryRow>
}

export type ApprovalAction = 'approve' | 'send_back' | 'reject' | 'stop'

export type MyDayResponse = {
  open: Task[]
  waiting: Task[]
  closedToday: Task[]
  /** By task id, for approval tasks. */
  approvals: Record<string, ApprovalView>
}

export type NavCounts = { myDay: number; approvals: number }

export type ProcurementReason = 'production' | 'expedite' | 'shortage'
export type ProcurementRequestStatus = 'open' | 'done' | 'cancelled'

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
  status: ProcurementRequestStatus
  taskId: string | null
  note: string | null
  createdAt: string
}

export type ProcurementRequestRow = ProcurementRequest & { docNo: string | null; poNo: string | null; partyName: string | null }

/** A receipt Tierra knows about before SAP does. Shown as unposted until the next import absorbs it. */
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

export type ProcurementRequestsResponse = Paged<ProcurementRequestRow> & { kpis: ProcurementKpis }
export type StockAdjustmentsResponse = Paged<StockAdjustment> & { kpis: ProcurementKpis }

export type DocumentKind = 'customer_po' | 'other' | 'so_pdf' | 'so_annex' | 'report'

/** A stored PDF as a list row; opens at `/api/documents/<id>`. */
export type DocumentInfo = {
  id: string
  filename: string
  kind: DocumentKind
  subjectType: string | null
  subjectId: string | null
  version: number
  createdAt: string
}

/** `GET /api/sales-orders/:id` (id or doc no). */
export type TsoResponse = {
  order: Tso
  po: CustomerPo | null
  check: InventoryCheck | null
  approvals: Approval[]
  requests: ProcurementRequest[]
  documents: DocumentInfo[]
  /** Internal only (HSN differences); never printed on the customer copy. */
  warnings: string[]
  tasks: Task[]
  /** What has to be made, as sentences. */
  make: string[]
  cardName: string | null
  group: { jid: string; subject: string } | null
}

/** A SAP attachment file on record for a document; opens at `href` (`/api/files/<sha256>`). */
export type DocFile = {
  sha256: string
  role: string
  fileName: string
  mime: string
  sizeBytes: number
  href: string
}

/** `GET /api/document-files?docs=13:5120,20:881`: files by "<SAP object>:<doc entry>". */
export type DocumentFilesResponse = { files: Record<string, DocFile[]> }

// ---- P6: payments and the daily report

export const PAYMENT_TABS = ['bank', 'receipts', 'purposes', 'receivables', 'payables', 'approvals'] as const
export type PaymentTab = (typeof PAYMENT_TABS)[number]

export type BankAccount = {
  glCode: string
  name: string
  shortName: string
  kind: 'bank' | 'cash'
  houseBank: boolean
  active: boolean
  displayOrder: number
}

export type FinanceKpis = {
  asOf: string
  banks: Array<{ glCode: string; bank: string; balance: number; houseBank: boolean }>
  cash: number
  receiptsMtd: number
  paymentsMtd: number
  pendingApprovals: { count: number; amount: number; oldest: string | null }
  netReceivable: number
  netPayable: number
}

export type BankBookRow = {
  transId: number
  lineId: number
  refDate: string
  createdAt: string | null
  debit: number
  credit: number
  balance: number
  label: string
  transType: string
  sourceNo: string | null
  paymentMemo: string | null
  memo: string | null
  paymentCancelled: boolean
  isReversal: boolean
}

export type PaymentRow = {
  direction: 'in' | 'out'
  docEntry: number
  docNo: string
  docDate: string
  createdAt: string | null
  kind: 'customer' | 'supplier' | 'account'
  cardCode: string | null
  cardName: string | null
  bank: string | null
  amount: number
  onAccount: number
  applied: number
  purposeGl: string | null
  purposeName: string | null
  transfer: boolean
  memo: string | null
  cancelled: boolean
}

export type PurposeRow = { key: string; label: string; kind: 'account' | 'supplier' | 'customer' | 'transfer'; count: number; amount: number }

export const AGE_BUCKETS = ['not_due', '1_30', '31_60', '61_90', '91_180', 'over_180'] as const
export type AgeBucket = (typeof AGE_BUCKETS)[number]
export type Buckets = Record<AgeBucket, number>

export type AgeingGroup = { groupKey: string; pan: string | null; name: string; cards: number; net: number; buckets: Buckets; overdue: number }

export type CardBalance = {
  cardCode: string
  cardName: string
  cardType: string
  pan: string | null
  groupKey: string
  owed: number
  lastMoved: string | null
  buckets: Buckets
}

export type PaymentRequestRow = {
  requestId: number
  status: 'pending' | 'approved' | 'rejected'
  docDate: string | null
  requestedAt: string | null
  decidedAt: string | null
  originator: string | null
  approver: string | null
  kind: string
  cardCode: string | null
  cardName: string | null
  bank: string | null
  amount: number
  purposeName: string | null
  memo: string | null
  paymentDocEntry: number | null
}

/** `GET /api/payments?tab=…` (manager and admin). */
export type PaymentsResponse = {
  asOf: string
  tab: PaymentTab
  from: string
  to: string
  kpis: FinanceKpis
  accounts: BankAccount[]
  bank?: (Paged<BankBookRow> & { account: BankAccount; opening: number; closing: number; receipts: number; payments: number }) | null
  list?: (Paged<PaymentRow> & { amount: number }) | null
  purposes?: { rows: PurposeRow[]; total: number }
  purpose?: string | null
  ageing?: { rows: AgeingGroup[]; total: number; totals: Buckets & { net: number } }
  group?: string | null
  cards?: CardBalance[] | null
  topCards?: CardBalance[]
  status?: 'pending' | 'approved' | 'rejected'
  requests?: Paged<PaymentRequestRow> & { amount: number }
}

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

export const OUTWARDS_BASES = ['created_window', 'doc_date', 'ewb_date'] as const
export type OutwardsBasis = (typeof OUTWARDS_BASES)[number]

export type DailyInputs = {
  reportDate: string
  productionRun: boolean | null
  packingRun: boolean | null
  cartoningRun: boolean | null
  manpower: Manpower | null
  bananaKgEstimate: number | null
  cassavaKgEstimate: number | null
  inwardRemarks: Record<string, string>
  notes: string | null
  enteredBy: string | null
  enteredByName: string | null
  enteredAt: string | null
}

export type ReportLine = { label: string; bank: string; amount: number; ref: string | null; memo: string | null; transfer: boolean; movedFrom: string | null }
export type ActivityFlag = { value: boolean | null; source: 'input' | 'sap' | null; detail: string | null }

export type DailyReportPayload = {
  kind: 'full' | 'inputs_only'
  reportDate: string
  basis: OutwardsBasis
  cutoff: string
  dataAsOf: string | null
  generatedAt: string
  activity: { production: ActivityFlag; packing: ActivityFlag; cartoning: ActivityFlag }
  manpower: { values: Manpower | null; total: number | null }
  banks: Array<{ glCode: string; bank: string; houseBank: boolean; opening: number; receipts: number; payments: number; closing: number }>
  receipts: ReportLine[]
  payments: ReportLine[]
  inwards: Array<{ key: string; label: string; quantity: string | null; estimateKg: number | null; remarks: string | null; grns: string[] }>
  outwards: { rows: Array<{ label: string; amount: number; invoices: string[] }>; total: number; monthToDate: number | null; monthLabel: string }
  notes: string | null
  missing: string[]
  footnotes: string[]
  knownDifferences: string[]
}

/** `GET /api/reports`. */
export type ReportsInfo = {
  dataAsOf: string | null
  defaultDate: string
  basis: OutwardsBasis
  cutoff: string
  canSeeReport: boolean
  canEditInputs: boolean
  canChangeBasis: boolean
}

export type DailyReportResponse = {
  payload: DailyReportPayload
  latest: { id: string; version: number; createdAt: string; documentId: string | null } | null
}

export type DailyInputsResponse = { date: string; inputs: DailyInputs | null; canEdit?: boolean }

// ------------------------------------------------------------------------------------------------ P7: costing, payroll

export const COSTING_TABS = ['skus', 'customers', 'orders', 'mix', 'valuation'] as const
export type CostingTab = (typeof COSTING_TABS)[number]
export const COSTING_SPANS = ['1', '3', '6', '12'] as const

export type CostingKpis = {
  month: string
  producedKg: number
  producedPcs: number
  productionValue: number
  materialCostPerKg: number | null
  soldKg: number
  revenue: number
  materialCost: number
  materialMargin: number
  marginPerKg: number | null
  marginPct: number | null
}

export type MarginRow = {
  key: string
  itemCode: string | null
  name: string
  cards: number
  qty: number
  kg: number
  revenue: number
  materialCost: number
  cogs: number
  margin: number
  pricePerPc: number | null
  costPerPc: number | null
  cogsPerPc: number | null
  marginPerPc: number | null
  marginPerKg: number | null
  marginPct: number | null
  cogsFallbackPct: number
}

export type ProductionCostRow = {
  docEntry: number
  docNo: string
  itemCode: string
  itemName: string | null
  status: string
  lastReceipt: string | null
  customerName: string | null
  producedQty: number
  producedKg: number | null
  issuedValue: number
  returnedValue: number
  materialCost: number
  costPerPc: number | null
  costPerKg: number | null
  breakdown: Array<{ role: string; value: number }>
  overheadQty: number
}

export type MaterialMixRow = { month: string; role: string; netValue: number; issuedValue: number; returnedValue: number; issuedKg: number | null; issuedQty: number }
export type ValuationRow = { groupName: string; whsCode: string; method: string; items: number; qty: number; value: number; customerSupplied: boolean }

/** `GET /api/costing` (manager and admin). Material cost only. */
export type CostingResponse = {
  asOf: string
  month: string
  span: (typeof COSTING_SPANS)[number]
  from: string
  to: string
  months: string[]
  tab: CostingTab
  note: string
  kpis: { current: CostingKpis; previous: CostingKpis }
  wip: { rows: Array<{ month: string; net: number; debit: number; credit: number }>; balance: number; account: string | null }
  margins?: { rows: MarginRow[]; totals: Omit<MarginRow, 'key' | 'itemCode' | 'name' | 'cards'>; count: number }
  orders?: Paged<ProductionCostRow> & { totals: { orders: number; producedQty: number; producedKg: number; materialCost: number; costPerKg: number | null } }
  mix?: MaterialMixRow[]
  valuation?: { rows: ValuationRow[]; total: number; glInventory: number; wipBalance: number }
}

export type PayrollCategory = {
  category: string
  label: string
  people: number
  grossEarned: number
  totalEarning: number
  pf: number
  esi: number
  deductions: number
  net: number
}

export type PayrollRunSummary = {
  runId: string
  month: string
  source: 'voyon' | 'register' | 'temp_sheet' | string
  label: string
  fileName: string
  headcount: number
  grossEarned: number
  totalEarning: number
  deductions: number
  net: number
  pf: number
  esi: number
  tds: number
  basic: number
  categories: PayrollCategory[]
}

/** `GET /api/payroll` (the admin only). From the HR files, not SAP. */
export type PayrollResponse = {
  importedAt: string | null
  months: string[]
  peelingMonths: string[]
  month: string
  payroll: { month: string; runs: PayrollRunSummary[] }
  headcount: {
    total: number
    voyonMaster: number
    onVoyonPayroll: number
    registerOnly: number
    temps: Array<{ block: string; label: string; people: number }>
    byDepartment: Array<{ department: string; people: number; onPayroll: number }>
    byCategory: Array<{ category: string; label: string; people: number }>
    punch: Array<{ status: string; people: number }>
  }
  attendance: {
    month: string
    days: string[]
    codes: Record<string, number>
    perDay: Array<{ date: string; present: number; leave: number; lwp: number; off: number }>
    people: number
    rows?: Array<{ employeeId: string; name: string; category: string | null; marks: Record<string, string>; present: number; lwp: number }>
  } | null
  peeling: {
    month: string
    days: number
    classes: Array<{ workerClass: string; workers: number; kg: number; incentive: number }>
    totalKg: number
    totalIncentive: number
    leaderboard?: Array<{ name: string; workerClass: string; kg: number; days: number; avgKg: number; incentive: number }>
  } | null
  leave: { count: number; days: number; byType: Array<{ leaveType: string; requests: number; days: number }>; byStatus: Array<{ status: string; requests: number }> }
  reconciliation: {
    month: string
    payroll: { voyonNet: number | null; voyonEarned: number | null; registerEarned: number | null; registerNet: number | null; tempEarned: number | null; tempNet: number | null }
    journal: Array<{ account: string; amount: number }>
    journalTotal: number
    employerContribution: number
    paidInMonth: number
    paidNextMonth: number
    paymentsNextMonth: number
  } | null
}

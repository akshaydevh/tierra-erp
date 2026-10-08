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
export type OrderStatus = 'open' | 'closed'
export type OrderSource = 'seed' | 'whatsapp' | 'desk'

export const DESK_THREAD_PREFIX = 'desk:'

export function orderSourceForThread(remoteJid: string): 'whatsapp' | 'desk' {
  return remoteJid.startsWith(DESK_THREAD_PREFIX) ? 'desk' : 'whatsapp'
}
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

export type Customer = {
  id: string
  name: string
  code: string
}

export type ItemKind = 'finished_good' | 'laminate' | 'seasoning' | 'carton' | 'raw_material'

export function asItemKind(value: string): ItemKind {
  if (
    value === 'finished_good' ||
    value === 'laminate' ||
    value === 'seasoning' ||
    value === 'carton' ||
    value === 'raw_material'
  ) {
    return value
  }
  throw new Error(`Unknown item kind ${value}`)
}

export type Item = {
  id: string
  sku: string
  name: string
  unit: string
  kind: ItemKind
}

export type Balance = {
  id: string
  customerId: string | null
  itemId: string
  onHand: number
}

export type OrderRecord = {
  id: string
  customerId: string
  customerName: string
  poNumber: string
  poDate: string | null
  status: OrderStatus
  source: OrderSource
  createdAt: string
}

export type OrderLineRecord = {
  id: string
  orderId: string
  itemId: string
  sku: string
  itemName: string
  description: string
  quantity: number
  unit: string
  unitPrice: string | null
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

export type NewOrderLine = {
  itemId: string
  description: string
  quantity: number
  unit: string
  unitPrice: string | null
}

export type ProductionPlan = {
  finishedGoodsKg: string
  kgBananaPerKgChips: string
  bananaKg: string
  sourceMonths: string
  rawItemId: string
  assigneeId: string
}

export type ProductionEntryRecord = {
  id: string
  orderId: string
  poNumber: string
  customerName: string
  finishedGoodsKg: string
  kgBananaPerKgChips: string
  bananaKg: string
  sourceMonths: string
  createdAt: string
}

export type ProcurementOrderRecord = {
  id: string
  orderId: string | null
  poNumber: string
  customerName: string
  productionEntryId: string | null
  itemName: string
  quantityKg: string
  unit: string
  assigneeId: string
  assigneeName: string
  createdAt: string
}

export type PendingConfirmation = {
  id: string
  poNumber: string
  lines: NewOrderLine[]
}

export type StoredDocument = {
  filename: string
  mimeType: string
  content: Buffer
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

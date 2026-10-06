export type Role = 'admin' | 'office'
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
export type TaskStatus = 'todo' | 'doing' | 'done'

export function asTaskCategory(value: string): TaskCategory {
  if ((TASK_CATEGORIES as readonly string[]).includes(value)) return value as TaskCategory
  throw new Error(`Unknown task category ${value}`)
}

export function asTaskStatus(value: string): TaskStatus {
  if (value === 'todo' || value === 'doing' || value === 'done') return value
  throw new Error(`Unknown task status ${value}`)
}

export type TaskRecord = {
  id: string
  title: string
  category: TaskCategory
  status: TaskStatus
  assigneeId: string | null
  assigneeName: string | null
  createdBy: string
  createdAt: string
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

export type ClaimedMessage = {
  evolutionMessageId: string
  remoteJid: string
  fromMe: boolean
  hasPdf: boolean
  body: string | null
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

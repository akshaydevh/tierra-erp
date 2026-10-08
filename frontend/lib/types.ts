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

export type OrderListItem = {
  id: string
  poNumber: string
  customerName: string
  status: 'open' | 'closed'
  source: 'seed' | 'whatsapp' | 'desk'
  poDate: string | null
  lineCount: number
  createdAt: string
}

export type OrderLine = {
  id: string
  sku: string
  itemName: string
  description: string
  quantity: number
  unit: string
  unitPrice: string | null
}

export type ProductionEntry = {
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

export type ProcurementOrder = {
  id: string
  orderId: string | null
  poNumber: string
  customerName: string
  productionEntryId: string | null
  itemName: string
  quantityKg: string
  unit: string
  assigneeName: string
  createdAt: string
}

export type OrderDetail = OrderListItem & {
  lines: OrderLine[]
  hasDocument: boolean
  production: ProductionEntry | null
  procurement: ProcurementOrder | null
}

export type MaterialKind = 'laminate' | 'seasoning' | 'carton'

export type InventoryItem = {
  customerId: string
  customerName: string
  customerCode: string
  itemId: string
  sku: string
  name: string
  unit: string
  kind: MaterialKind
  onHand: number
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
  status: 'disconnected' | 'qr_pending' | 'connected'
  qrBase64: string | null
  phoneNumber: string | null
}

export type CommandCentre = {
  openOrders: number
  shortLines: number
  whatsapp: { status: WhatsappConnection['status']; phoneNumber: string | null }
  recentOrders: OrderListItem[]
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

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
  ProcurementOrderRecord,
  ProductionEntryRecord,
  PendingConfirmation,
  ProductionPlan,
  PublicUser,
  StoredDocument,
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

  claimMessage(message: ClaimedMessage): Promise<boolean>
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
  createTask(input: {
    title: string
    category: TaskCategory
    assigneeId: string | null
    createdBy: string
  }): Promise<TaskRecord>
  updateTaskStatus(id: string, status: TaskStatus): Promise<TaskRecord | null>
  updateTaskAssignee(id: string, assigneeId: string | null): Promise<TaskRecord | null>
}

export type Role = 'admin' | 'office'
export type OrderStatus = 'open' | 'closed'
export type OrderSource = 'seed' | 'whatsapp'
export type WhatsappStatus = 'disconnected' | 'qr_pending' | 'connected'

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

export type Item = {
  id: string
  sku: string
  name: string
  unit: string
}

export type Balance = {
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

export type StoredDocument = {
  filename: string
  mimeType: string
  content: Buffer
}

export function toPublicUser(user: User): PublicUser {
  return { id: user.id, email: user.email, name: user.name, role: user.role }
}

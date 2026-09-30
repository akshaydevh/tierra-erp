export type Role = 'admin' | 'office'

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
  source: 'seed' | 'whatsapp'
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

export type OrderDetail = OrderListItem & {
  lines: OrderLine[]
  hasDocument: boolean
}

export type InventoryItem = {
  itemId: string
  sku: string
  name: string
  unit: string
  onHand: number
  reserved: number
  available: number
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

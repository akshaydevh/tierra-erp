import {
  availableQuantity,
  CustomerInventory,
  shortLineCount,
  type CustomerMaterialRow,
} from '../domain/inventory'
import type { Store } from '../db/store'
import type {
  OrderLineRecord,
  OrderRecord,
  ProcurementOrderRecord,
  ProductionEntryRecord,
  TaskRecord,
  WhatsappConnection,
} from '../db/types'

export type InventoryRow = CustomerMaterialRow

export type OrderListItem = OrderRecord & { lineCount: number }

export type OrderDetail = OrderRecord & {
  lines: OrderLineRecord[]
  hasDocument: boolean
  production: ProductionEntryRecord | null
  procurement: ProcurementOrderRecord | null
}

export type CommandCentre = {
  openOrders: number
  shortLines: number
  whatsapp: Pick<WhatsappConnection, 'status' | 'phoneNumber'>
  recentOrders: OrderListItem[]
}

export function availabilityMap(
  balances: Array<{ itemId: string; onHand: number; customerId?: string | null }>,
  lines: OrderLineRecord[],
  orders: OrderRecord[],
): Map<string, number> {
  const status = new Map(orders.map((order) => [order.id, order.status]))
  const reserved = new Map<string, number>()
  for (const line of lines) {
    if (status.get(line.orderId) !== 'open') continue
    reserved.set(line.itemId, (reserved.get(line.itemId) ?? 0) + line.quantity)
  }
  const available = new Map<string, number>()
  for (const balance of balances) {
    if (balance.customerId) continue
    available.set(balance.itemId, availableQuantity(balance.onHand, reserved.get(balance.itemId) ?? 0))
  }
  return available
}

export async function inventoryRows(store: Store): Promise<InventoryRow[]> {
  const [items, balances, customers] = await Promise.all([
    store.listItems(),
    store.listBalances(),
    store.listCustomers(),
  ])
  return CustomerInventory.from(items, balances, customers).rows
}

export async function orderList(store: Store): Promise<OrderListItem[]> {
  const [orders, lines] = await Promise.all([store.listOrders(), store.listOrderLines()])
  return orders.map((order) => ({
    ...order,
    lineCount: lines.filter((line) => line.orderId === order.id).length,
  }))
}

export async function orderDetail(store: Store, id: string): Promise<OrderDetail | null> {
  const orders = await store.listOrders()
  const order = orders.find((row) => row.id === id)
  if (!order) return null
  const [lines, productionEntries, procurementOrders, hasDocument] = await Promise.all([
    store.listOrderLines(),
    store.listProductionEntries(),
    store.listProcurementOrders(),
    store.orderHasDocument(id),
  ])
  return {
    ...order,
    lines: lines.filter((line) => line.orderId === id),
    hasDocument,
    production: productionEntries.find((entry) => entry.orderId === id) ?? null,
    procurement: procurementOrders.find((entry) => entry.orderId === id) ?? null,
  }
}

export const EMPTY_DASHBOARD_MODULES = [
  'My Day',
  'Approvals',
  'Dispatch',
  'Payments',
  'Costing',
  'Payroll and attendance',
  'Reports',
  'Masters',
] as const

export type DashboardOrderLine = {
  sku: string
  name: string
  description: string
  quantity: number
  unit: string
  unitPrice: string | null
}

export type DashboardSnapshot = {
  commandCentre: CommandCentre
  customers: Array<{ name: string; code: string }>
  orders: Array<{
    id: string
    customerName: string
    poNumber: string
    poDate: string | null
    status: string
    source: string
    lines: DashboardOrderLine[]
  }>
  inventory: InventoryRow[]
  tasks: Array<Pick<TaskRecord, 'title' | 'category' | 'status' | 'assigneeName'>>
  emptyModules: string[]
}

export async function dashboardSnapshot(store: Store): Promise<DashboardSnapshot> {
  const [centre, customers, orders, lines, inventory, tasks] = await Promise.all([
    commandCentre(store),
    store.listCustomers(),
    store.listOrders(),
    store.listOrderLines(),
    inventoryRows(store),
    store.listTasks(),
  ])
  return {
    commandCentre: centre,
    customers: customers.map((customer) => ({ name: customer.name, code: customer.code })),
    orders: orders.map((order) => ({
      id: order.id,
      customerName: order.customerName,
      poNumber: order.poNumber,
      poDate: order.poDate,
      status: order.status,
      source: order.source,
      lines: lines
        .filter((line) => line.orderId === order.id)
        .map((line) => ({
          sku: line.sku,
          name: line.itemName,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit,
          unitPrice: line.unitPrice,
        })),
    })),
    inventory,
    tasks: tasks
      .filter((task) => task.status !== 'done')
      .map((task) => ({
        title: task.title,
        category: task.category,
        status: task.status,
        assigneeName: task.assigneeName,
      })),
    emptyModules: [...EMPTY_DASHBOARD_MODULES],
  }
}

export async function commandCentre(store: Store): Promise<CommandCentre> {
  const [orders, lines, balances, whatsapp] = await Promise.all([
    store.listOrders(),
    store.listOrderLines(),
    store.listBalances(),
    store.getWhatsapp(),
  ])
  const available = availabilityMap(balances, lines, orders)
  const listed = orders.map((order) => ({
    ...order,
    lineCount: lines.filter((line) => line.orderId === order.id).length,
  }))
  return {
    openOrders: orders.filter((order) => order.status === 'open').length,
    shortLines: shortLineCount(
      lines.map((line) => ({
        itemId: line.itemId,
        status: orders.find((order) => order.id === line.orderId)?.status ?? 'closed',
      })),
      available,
    ),
    whatsapp: { status: whatsapp.status, phoneNumber: whatsapp.phoneNumber },
    recentOrders: listed.slice(0, 5),
  }
}

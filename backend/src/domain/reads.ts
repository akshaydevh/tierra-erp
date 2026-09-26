import { availableQuantity, shortLineCount } from '../domain/inventory'
import type { Store } from '../db/store'
import type { OrderLineRecord, OrderRecord, WhatsappConnection } from '../db/types'

export type InventoryRow = {
  itemId: string
  sku: string
  name: string
  unit: string
  onHand: number
  reserved: number
  available: number
}

export type OrderListItem = OrderRecord & { lineCount: number }

export type OrderDetail = OrderRecord & {
  lines: OrderLineRecord[]
  hasDocument: boolean
}

export type CommandCentre = {
  openOrders: number
  shortLines: number
  whatsapp: Pick<WhatsappConnection, 'status' | 'phoneNumber'>
  recentOrders: OrderListItem[]
}

export function availabilityMap(
  balances: Array<{ itemId: string; onHand: number }>,
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
    available.set(balance.itemId, availableQuantity(balance.onHand, reserved.get(balance.itemId) ?? 0))
  }
  return available
}

export async function inventoryRows(store: Store): Promise<InventoryRow[]> {
  const [items, balances, lines, orders] = await Promise.all([
    store.listItems(),
    store.listBalances(),
    store.listOrderLines(),
    store.listOrders(),
  ])
  const available = availabilityMap(balances, lines, orders)
  const status = new Map(orders.map((order) => [order.id, order.status]))
  return items.map((item) => {
    const onHand = balances.find((row) => row.itemId === item.id)?.onHand ?? 0
    const reserved = lines
      .filter((line) => line.itemId === item.id && status.get(line.orderId) === 'open')
      .reduce((sum, line) => sum + line.quantity, 0)
    return {
      itemId: item.id,
      sku: item.sku,
      name: item.name,
      unit: item.unit,
      onHand,
      reserved,
      available: available.get(item.id) ?? availableQuantity(onHand, reserved),
    }
  })
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
  const lines = (await store.listOrderLines()).filter((line) => line.orderId === id)
  return { ...order, lines, hasDocument: await store.orderHasDocument(id) }
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

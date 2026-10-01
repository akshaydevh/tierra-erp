import type { Balance, Customer, Item } from '../db/types'

export const materialKinds = ['laminate', 'seasoning', 'carton'] as const
export type MaterialKind = (typeof materialKinds)[number]

export function isMaterialKind(value: string): value is MaterialKind {
  return (materialKinds as readonly string[]).includes(value)
}

export type CustomerMaterialRow = {
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

const kindOrder: Record<MaterialKind, number> = {
  laminate: 0,
  seasoning: 1,
  carton: 2,
}

export class CustomerInventory {
  readonly rows: CustomerMaterialRow[]

  constructor(rows: CustomerMaterialRow[]) {
    this.rows = [...rows].sort((a, b) => {
      const byCustomer = a.customerName.localeCompare(b.customerName)
      if (byCustomer !== 0) return byCustomer
      const byKind = kindOrder[a.kind] - kindOrder[b.kind]
      if (byKind !== 0) return byKind
      return a.sku.localeCompare(b.sku)
    })
  }

  static from(items: Item[], balances: Balance[], customers: Customer[]): CustomerInventory {
    const itemsById = new Map(items.map((item) => [item.id, item]))
    const customersById = new Map(customers.map((customer) => [customer.id, customer]))
    const rows: CustomerMaterialRow[] = []
    for (const balance of balances) {
      if (!balance.customerId) continue
      const item = itemsById.get(balance.itemId)
      const customer = customersById.get(balance.customerId)
      if (!item || !customer || !isMaterialKind(item.kind)) continue
      rows.push({
        customerId: customer.id,
        customerName: customer.name,
        customerCode: customer.code,
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        unit: item.unit,
        kind: item.kind,
        onHand: balance.onHand,
      })
    }
    return new CustomerInventory(rows)
  }

  forCustomer(customerId: string): CustomerMaterialRow[] {
    return this.rows.filter((row) => row.customerId === customerId)
  }

  onHand(customerId: string, kind: MaterialKind): number {
    return this.forCustomer(customerId)
      .filter((row) => row.kind === kind)
      .reduce((sum, row) => sum + row.onHand, 0)
  }
}

export function availableQuantity(onHand: number, reserved: number): number {
  return onHand - reserved
}

export type OpenLineRef = {
  itemId: string
  status: 'open' | 'closed'
}

export function shortLineCount(
  lines: OpenLineRef[],
  availableByItem: Map<string, number>,
): number {
  return lines.filter(
    (line) => line.status === 'open' && (availableByItem.get(line.itemId) ?? 0) < 0,
  ).length
}

export class StockShortError extends Error {
  constructor(
    readonly shortages: Array<{
      sku: string
      name: string
      requested: number
      available: number
    }>,
  ) {
    super('Not enough stock')
    this.name = 'StockShortError'
  }
}

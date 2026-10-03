import type { CustomerInventory } from './inventory'
import type { Customer, Item } from '../db/types'

export type ExtractedLine = {
  description: string
  quantity: number
  unit: string | null
  buyerCode: string | null
  price: number | null
}

export type ExtractedPo = {
  customerName: string
  poNumber: string
  poDate: string | null
  lines: ExtractedLine[]
}

export type MatchedLine = {
  itemId: string
  sku: string
  name: string
  description: string
  quantity: number
  unit: string
  unitPrice: string | null
}

export type Shortage = {
  sku: string
  name: string
  requested: number
  available: number
}

export type IntakeDecision =
  | { kind: 'no_inventory'; customerName: string }
  | { kind: 'unmatched_lines'; descriptions: string[] }
  | { kind: 'short'; poNumber: string; shortages: Shortage[] }
  | {
      kind: 'ok'
      customerId: string
      poNumber: string
      poDate: string | null
      lines: MatchedLine[]
    }

function norm(value: string): string {
  return value.trim().toLowerCase()
}

function bestInclude<T>(items: T[], label: (item: T) => string, query: string): T | undefined {
  if (query.length < 4) return undefined
  const hits = items.filter((item) => {
    const name = norm(label(item))
    return query.includes(name) || name.includes(query)
  })
  hits.sort((a, b) => label(b).length - label(a).length)
  return hits[0]
}

export function isPurchaseOrderText(text: string): boolean {
  return /\bpurchase\s+order\b/i.test(text)
}

export function matchCustomer(name: string, customers: Customer[]): Customer | undefined {
  const query = norm(name)
  return (
    customers.find((customer) => norm(customer.name) === query) ??
    bestInclude(customers, (customer) => customer.name, query)
  )
}

export function matchItem(line: ExtractedLine, items: Item[]): Item | undefined {
  const goods = items.filter((item) => item.kind === 'finished_good')
  const code = line.buyerCode ? norm(line.buyerCode) : ''
  if (code) {
    const bySku = goods.find((item) => norm(item.sku) === code)
    if (bySku) return bySku
  }
  const query = norm(line.description)
  return (
    goods.find((item) => norm(item.name) === query || norm(item.sku) === query) ??
    bestInclude(goods, (item) => item.sku, query) ??
    bestInclude(goods, (item) => item.name, query)
  )
}

export function decideIntake(
  po: ExtractedPo,
  customers: Customer[],
  items: Item[],
  availableByItem: Map<string, number>,
  inventory: CustomerInventory,
): IntakeDecision {
  const customer = matchCustomer(po.customerName, customers)
  if (!customer || inventory.forCustomer(customer.id).length === 0) {
    return { kind: 'no_inventory', customerName: customer?.name ?? po.customerName }
  }

  const unmatched: string[] = []
  const grouped = new Map<string, MatchedLine>()
  for (const line of po.lines) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      unmatched.push(line.description)
      continue
    }
    const item = matchItem(line, items)
    if (!item) {
      unmatched.push(line.description)
      continue
    }
    const existing = grouped.get(item.id)
    const unitPrice = line.price == null ? null : line.price.toFixed(2)
    if (existing) {
      existing.quantity += line.quantity
      if (!existing.unitPrice && unitPrice) existing.unitPrice = unitPrice
    } else {
      grouped.set(item.id, {
        itemId: item.id,
        sku: item.sku,
        name: item.name,
        description: line.description,
        quantity: line.quantity,
        unit: item.unit,
        unitPrice,
      })
    }
  }
  if (unmatched.length > 0) return { kind: 'unmatched_lines', descriptions: unmatched }

  const shortages: Shortage[] = []
  for (const line of grouped.values()) {
    const available = availableByItem.get(line.itemId) ?? 0
    if (line.quantity > available) {
      shortages.push({
        sku: line.sku,
        name: line.name,
        requested: line.quantity,
        available,
      })
    }
  }
  if (shortages.length > 0) return { kind: 'short', poNumber: po.poNumber, shortages }

  return {
    kind: 'ok',
    customerId: customer.id,
    poNumber: po.poNumber,
    poDate: po.poDate,
    lines: [...grouped.values()],
  }
}

export function noInventoryReply(customerName: string): string {
  return `${customerName} has no laminate, seasoning, or carton inventory on file. No order was created.`
}

export function lineFailureReply(descriptions: string[]): string {
  return `Could not match these lines to items: ${descriptions.join(', ')}. No order was created.`
}

export function shortReply(poNumber: string, shortages: Shortage[]): string {
  const lines = shortages
    .map(
      (row) =>
        `${row.name} (${row.sku}): requested ${row.requested}, available ${row.available}.`,
    )
    .join('\n')
  return `Not enough stock to fulfil PO ${poNumber}.\n${lines}\nNo order was created.`
}

export function createdReply(orderId: string, poNumber: string): string {
  return `Created order ${orderId} for PO ${poNumber}.`
}

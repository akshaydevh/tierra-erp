import { gramsFromDescription } from './banana'
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
  itemId: string
  sku: string
  name: string
  requested: number
  available: number
  unit: string
}

export type IntakeDecision =
  | { kind: 'no_inventory'; customerName: string }
  | { kind: 'unmatched_lines'; descriptions: string[] }
  | {
      kind: 'short'
      customerId: string
      poNumber: string
      poDate: string | null
      lines: MatchedLine[]
      shortages: Shortage[]
    }
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

const HOUSE_BRANDS = new Set(['tierra'])
const PACK_NOISE = new Set([
  'pp',
  'pouch',
  'pouches',
  'packet',
  'packets',
  'pkt',
  'prm',
  'premium',
  'kerala',
  'salted',
])

function productTokens(text: string): string[] {
  const withoutWeight = text.replace(/(\d+(?:\.\d+)?)\s*(?:grams|gram|grms|grm|gms|gm|g)\b/gi, ' ')
  return withoutWeight
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !HOUSE_BRANDS.has(token) && !PACK_NOISE.has(token))
    .sort()
}

function sameTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((token, index) => token === right[index])
}

function matchByPack(description: string, goods: Item[]): Item | undefined {
  const grams = gramsFromDescription(description)
  const tokens = productTokens(description)
  if (grams == null || tokens.length === 0) return undefined
  const hits = goods.filter(
    (item) => gramsFromDescription(item.name) === grams && sameTokens(productTokens(item.name), tokens),
  )
  return hits.length === 1 ? hits[0] : undefined
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
    bestInclude(goods, (item) => item.name, query) ??
    matchByPack(line.description, goods)
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
    if (available < line.quantity) {
      shortages.push({
        itemId: line.itemId,
        sku: line.sku,
        name: line.name,
        requested: line.quantity,
        available,
        unit: line.unit,
      })
    }
  }
  if (shortages.length > 0) {
    return {
      kind: 'short',
      customerId: customer.id,
      poNumber: po.poNumber,
      poDate: po.poDate,
      lines: [...grouped.values()],
      shortages,
    }
  }

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

export function procureQuantity(requested: number, available: number): number {
  return requested - Math.max(available, 0)
}

export function shortStockReply(poNumber: string, shortages: Shortage[]): string {
  const names = shortages.map((row) => row.name)
  const lines = names.map((name) => `${name} is not available in sufficient quantity.`)
  lines.push(`Added ${names.join(', ')} to procurement, assigned to Joshy.`)
  lines.push(`No order was created. An admin can reply YES to confirm PO ${poNumber}.`)
  return lines.join('\n')
}

export function shortReply(poNumber: string, shortages: Array<{ name: string }>): string {
  const lines = shortages.map((row) => `${row.name} is not available in sufficient quantity.`)
  return `${lines.join('\n')}\nNo order was created for PO ${poNumber}.`
}

function formatKg(value: number): string {
  const [whole, fraction] = value.toFixed(3).split('.')
  const grouped = (whole ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${grouped}.${fraction}`
}

export function createdReply(input: {
  orderId: string
  poNumber: string
  finishedGoodsKg: number
  bananaKg: number
  procurementOrderId: string | null
  skipped: string[]
}): string {
  const lines = [`Created order ${input.orderId} for PO ${input.poNumber}.`]
  if (input.bananaKg > 0 && input.procurementOrderId) {
    lines.push(`Finished goods ${formatKg(input.finishedGoodsKg)} kg.`)
    lines.push(`Banana required ${formatKg(input.bananaKg)} kg.`)
    lines.push(`Procurement order ${input.procurementOrderId} is assigned to Joshy.`)
  }
  if (input.skipped.length > 0) {
    lines.push(`Left out of the banana calculation: ${input.skipped.join(', ')}.`)
  }
  return lines.join('\n')
}

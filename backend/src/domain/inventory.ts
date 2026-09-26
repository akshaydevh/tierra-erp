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

export const BANANA_YIELD_MONTHS = [
  { label: 'June 2026', bananaKg: 33961.67, chipsKg: 9092.02 },
  { label: 'July 2026', bananaKg: 100000, chipsKg: 23860 },
] as const

const PIECE_UNITS = new Set(['pc', 'pcs', 'ea', 'pouch', 'piece', 'pieces', 'nos', 'no'])

export type YieldLine = {
  description: string
  quantity: number
  unit: string | null
}

export type BananaRequirement = {
  finishedGoodsKg: number
  bananaKg: number
  kgBananaPerKgChips: number
  sourceMonths: string
  skipped: string[]
}

const GRAMS = /(\d+(?:\.\d+)?)\s*(?:grams|gram|grms|grm|gms|gm|g)\b/i

export function gramsFromDescription(description: string): number | null {
  const match = GRAMS.exec(description)
  if (!match) return null
  const grams = Number(match[1])
  return grams > 0 ? grams : null
}

export function isPieceUnit(unit: string | null): boolean {
  if (!unit) return false
  return PIECE_UNITS.has(unit.trim().toLowerCase())
}

export function kgBananaPerKgChips(
  months: ReadonlyArray<{ bananaKg: number; chipsKg: number }> = BANANA_YIELD_MONTHS,
): number {
  const bananaKg = months.reduce((sum, month) => sum + month.bananaKg, 0)
  const chipsKg = months.reduce((sum, month) => sum + month.chipsKg, 0)
  if (chipsKg <= 0) return 0
  return bananaKg / chipsKg
}

function roundKg(value: number): number {
  return Math.round(value * 1000) / 1000
}

export function bananaRequirement(lines: YieldLine[]): BananaRequirement {
  const factor = kgBananaPerKgChips()
  let finishedGoodsKg = 0
  const skipped: string[] = []
  for (const line of lines) {
    const grams = gramsFromDescription(line.description)
    if (!isPieceUnit(line.unit) || grams == null || !Number.isFinite(line.quantity) || line.quantity <= 0) {
      skipped.push(line.description)
      continue
    }
    finishedGoodsKg += (line.quantity * grams) / 1000
  }
  finishedGoodsKg = roundKg(finishedGoodsKg)
  return {
    finishedGoodsKg,
    bananaKg: roundKg(finishedGoodsKg * factor),
    kgBananaPerKgChips: roundKg(factor),
    sourceMonths: BANANA_YIELD_MONTHS.map((month) => month.label).join(', '),
    skipped,
  }
}

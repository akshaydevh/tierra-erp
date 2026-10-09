import type {
  CheckLineStatus,
  CheckVerdict,
  InventoryCheckLine,
  ItemOwner,
  ItemOwnerOverride,
  StockOverlay,
} from '../db/types'
import type { BomRow, ItemFacts, Ownership, StockTotals } from '../queries/po'

/**
 * The real inventory check (plan §P3, po-flow.md §5). Pure: the caller loads SAP and app facts, this decides.
 *
 * 1. Finished goods: free = SAP free (on hand - committed) - pieces reserved by Tierra SOs + active adjustments;
 *    to_make = max(0, pcs - max(free, 0)); the rest comes from stock.
 * 2. Explode the manual (M) BOM rows of what has to be made, single level: need = to_make x qty / basis.
 *    Carton = ceil(to_make / pieces per carton). Laminate in kg or in pieces as the item is counted.
 *    Fallbacks, marked estimated: a placeholder banana line = pack grams / 1000 x 3.571 kg per piece; a placeholder
 *    seasoning line or an implausible laminate line = the last 90 days' actual use per piece.
 * 3. Checked: laminate, carton, seasoning, raw banana / cassava, oil. Tape and consumables (LPG, ribbon) are
 *    warnings only.
 * 4. Per component: short_now = max(0, need - max(free, 0)); short_after_incoming = max(0, need - max(free +
 *    on_order, 0)). Verdict: pass (nothing short now), pass_with_incoming (short now, covered by open POs), fail.
 */

export const CHECKED_ROLES = ['laminate', 'carton', 'seasoning', 'raw_banana', 'raw_cassava', 'oil'] as const
export const WARNING_ROLES = ['tape', 'consumable'] as const
const ROLE_ORDER = [...CHECKED_ROLES, ...WARNING_ROLES] as string[]

/** Raw banana (and cassava) per kg of chips, from Tierra's banana and tapioca chips BOMs. */
export const BANANA_KG_PER_KG = 3.571

export type CheckRequest = { itemCode: string; pcs: number }

export type CheckFacts = {
  items: Record<string, ItemFacts>
  boms: Record<string, BomRow[]>
  stock: Record<string, StockTotals>
  overlays: Record<string, StockOverlay>
  ownership: Record<string, Ownership>
  overrides: ItemOwnerOverride[]
  /** Actual use per finished piece over 90 days: fg -> component -> qty. */
  usage: Record<string, Record<string, number>>
  incoming: Record<string, string[]>
}

export type CheckResult = {
  verdict: CheckVerdict
  lines: InventoryCheckLine[]
  warnings: string[]
}

export function round(value: number, places = 4): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

function lineStatus(shortNow: number, shortAfter: number): CheckLineStatus {
  if (shortAfter > 0) return 'short'
  if (shortNow > 0) return 'short_now'
  return 'ok'
}

function ownerOf(
  itemCode: string,
  facts: CheckFacts,
): { owner: ItemOwner; ownerCardCode: string | null; ownerName: string | null } {
  const override = facts.overrides.find((row) => row.itemCode === itemCode)
  if (override) return { owner: override.owner, ownerCardCode: override.ownerCardCode, ownerName: null }
  const ownership = facts.ownership[itemCode]
  if (ownership?.customerSupplied) {
    return ownership.ownerCardCode
      ? { owner: 'customer', ownerCardCode: ownership.ownerCardCode, ownerName: ownership.ownerName }
      : { owner: 'customer_unknown', ownerCardCode: null, ownerName: null }
  }
  return { owner: 'tierra', ownerCardCode: null, ownerName: null }
}

function freeOf(itemCode: string, facts: CheckFacts) {
  const stock = facts.stock[itemCode] ?? { onHand: 0, committed: 0, onOrder: 0 }
  const overlay = facts.overlays[itemCode] ?? { reserved: 0, adjustments: 0 }
  const free = round(stock.onHand - stock.committed - overlay.reserved + overlay.adjustments)
  return { ...stock, ...overlay, free }
}

type Need = { need: number; estimated: boolean; forItems: Set<string>; notes: Set<string> }

/** Laminate per piece that fits the unit it is counted in: a few grams in kg, about one in pieces. */
function plausibleLaminate(uom: string | null, perPiece: number): boolean {
  if (uom === 'kg') return perPiece > 0 && perPiece < 0.1
  if (uom === 'pcs' || uom === 'nos') return perPiece >= 0.5 && perPiece <= 3
  return perPiece > 0
}

function isCountable(uom: string | null): boolean {
  return uom === 'pcs' || uom === 'nos'
}

export function computeCheck(requested: CheckRequest[], facts: CheckFacts): CheckResult {
  const warnings: string[] = []
  const lines: InventoryCheckLine[] = []
  const pcsByItem = new Map<string, number>()
  for (const line of requested) {
    if (line.pcs > 0) pcsByItem.set(line.itemCode, (pcsByItem.get(line.itemCode) ?? 0) + line.pcs)
  }

  const needs = new Map<string, Need>()
  const addNeed = (code: string, qty: number, fg: string, estimated: boolean, note?: string) => {
    const entry = needs.get(code) ?? { need: 0, estimated: false, forItems: new Set<string>(), notes: new Set<string>() }
    entry.need += qty
    entry.estimated ||= estimated
    entry.forItems.add(fg)
    if (note) entry.notes.add(note)
    needs.set(code, entry)
  }

  for (const [fg, pcs] of pcsByItem) {
    const item = facts.items[fg]
    const stock = freeOf(fg, facts)
    const toMake = round(Math.max(0, pcs - Math.max(stock.free, 0)), 3)
    const fromStock = round(pcs - toMake, 3)
    const bom = (facts.boms[fg] ?? []).filter((row) => row.issueMethod === 'manual')
    const cannotMake = toMake > 0 && bom.length === 0
    if (cannotMake) warnings.push(`${fg} has no bill of materials in SAP, so its materials cannot be checked.`)
    lines.push({
      kind: 'fg',
      itemCode: fg,
      itemName: item?.itemName ?? null,
      role: 'fg',
      uom: 'pcs',
      need: pcs,
      onHand: stock.onHand,
      committed: stock.committed,
      reserved: stock.reserved,
      adjustments: stock.adjustments,
      free: stock.free,
      onOrder: stock.onOrder,
      shortNow: cannotMake ? toMake : 0,
      shortAfterIncoming: cannotMake ? toMake : 0,
      fromStock,
      toMake,
      owner: null,
      ownerCardCode: null,
      ownerName: null,
      checked: true,
      estimated: false,
      status: cannotMake ? 'short' : 'ok',
      incoming: [],
      forItems: [],
      note: cannotMake ? 'No BOM in SAP' : null,
    })
    if (toMake <= 0 || cannotMake) continue

    const npu = item?.pcsPerCarton ?? null
    const grams = item?.packGrams ?? null
    const usage = facts.usage[fg] ?? {}
    const roles = new Set<string>()
    for (const row of bom) {
      const component = facts.items[row.componentCode]
      const role = component?.role ?? 'other'
      if (!ROLE_ORDER.includes(role)) continue
      roles.add(role === 'raw_cassava' ? 'raw_banana' : role)
      const perPiece = row.basisQty > 0 ? row.qtyPerBasis / row.basisQty : 0
      const uom = component?.uom ?? null
      const actual = usage[row.componentCode]
      if (role === 'carton') {
        if (npu) addNeed(row.componentCode, Math.ceil(toMake / npu), fg, false)
        else addNeed(row.componentCode, Math.ceil(toMake * perPiece), fg, false, 'no pieces per carton in SAP; BOM quantity used')
      } else if ((role === 'raw_banana' || role === 'raw_cassava') && row.isPlaceholder) {
        if (grams) addNeed(row.componentCode, (toMake * grams * BANANA_KG_PER_KG) / 1000, fg, true, `placeholder BOM line; ${BANANA_KG_PER_KG} kg per kg of chips`)
        else if (actual) addNeed(row.componentCode, toMake * actual, fg, true, 'placeholder BOM line; 90-day actual use')
        else warnings.push(`${row.componentCode} for ${fg}: the BOM line is a placeholder and there is no pack size or usage to estimate it.`)
      } else if (role === 'seasoning' && row.isPlaceholder) {
        if (actual) addNeed(row.componentCode, toMake * actual, fg, true, 'placeholder BOM line; 90-day actual use')
        else warnings.push(`${row.componentCode} for ${fg}: the BOM line is a placeholder and there is no recent usage to estimate it.`)
      } else if (role === 'laminate' && !plausibleLaminate(uom, perPiece)) {
        if (actual) addNeed(row.componentCode, toMake * actual, fg, true, 'BOM quantity does not fit the unit; 90-day actual use')
        else {
          addNeed(row.componentCode, toMake * perPiece, fg, false, 'BOM quantity does not fit the unit; check it')
          warnings.push(`${row.componentCode} for ${fg}: the BOM laminate quantity does not fit its unit (${uom ?? 'no unit'}).`)
        }
      } else if (isCountable(uom) && (role === 'laminate' || role === 'tape')) {
        addNeed(row.componentCode, Math.ceil(toMake * perPiece), fg, false)
      } else {
        addNeed(row.componentCode, toMake * perPiece, fg, false)
      }
    }
    if (!roles.has('carton')) warnings.push(`${fg}: no carton in the BOM.`)
    if (!roles.has('laminate')) warnings.push(`${fg}: no laminate in the BOM.`)
  }

  const components: InventoryCheckLine[] = []
  for (const [code, entry] of needs) {
    const item = facts.items[code]
    const role = item?.role ?? null
    const checked = (CHECKED_ROLES as readonly string[]).includes(role ?? '')
    const need = round(entry.need)
    const stock = freeOf(code, facts)
    const shortNow = round(Math.max(0, need - Math.max(stock.free, 0)))
    const shortAfter = round(Math.max(0, need - Math.max(stock.free + stock.onOrder, 0)))
    components.push({
      kind: 'component',
      itemCode: code,
      itemName: item?.itemName ?? null,
      role,
      uom: item?.uom ?? null,
      need,
      onHand: stock.onHand,
      committed: stock.committed,
      reserved: stock.reserved,
      adjustments: stock.adjustments,
      free: stock.free,
      onOrder: stock.onOrder,
      shortNow,
      shortAfterIncoming: shortAfter,
      fromStock: null,
      toMake: null,
      ...ownerOf(code, facts),
      checked,
      estimated: entry.estimated,
      status: lineStatus(shortNow, shortAfter),
      incoming: facts.incoming[code] ?? [],
      forItems: [...entry.forItems],
      note: entry.notes.size ? [...entry.notes].join('; ') : null,
    })
  }
  components.sort(
    (a, b) => ROLE_ORDER.indexOf(a.role ?? '') - ROLE_ORDER.indexOf(b.role ?? '') || a.itemCode.localeCompare(b.itemCode),
  )
  lines.push(...components)

  const decisive = lines.filter((line) => line.checked)
  const verdict: CheckVerdict = decisive.some((line) => line.status === 'short')
    ? 'fail'
    : decisive.some((line) => line.status === 'short_now')
      ? 'pass_with_incoming'
      : 'pass'
  return { verdict, lines, warnings }
}

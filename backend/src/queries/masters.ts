import { num, numOrNull, searchPattern, text, textArray, type SapSql } from '../sap/db'

const PICKER_LIMIT = 50

export type ItemRow = {
  itemCode: string
  itemName: string
  groupCode: number | null
  groupName: string | null
  category: string | null
  materialRole: string | null
  uomRaw: string | null
  uom: string | null
  uomInferred: boolean
  pcsPerCarton: number | null
  packGrams: number | null
  gstRate: number | null
  batchManaged: boolean
  hasBom: boolean
  active: boolean
}

export type PartyRow = {
  cardCode: string
  cardName: string
  cardType: string
  groupName: string | null
  pan: string | null
  gstin: string | null
  city: string | null
  state: string | null
  phone: string | null
  mobile: string | null
  email: string | null
  balance: number | null
  active: boolean
}

/** Items whose code or name matches, active ones first; top 50. */
export async function searchItems(sql: SapSql, q?: string | null): Promise<ItemRow[]> {
  const like = searchPattern(q)
  const rows = await sql`
    select item_code, item_name, group_code, group_name, category, material_role, uom_raw, uom, uom_inferred,
           pcs_per_carton, pack_grams, gst_rate, batch_managed, has_bom, active
    from erp.items
    ${like ? sql`where item_code ilike ${like} or item_name ilike ${like}` : sql``}
    order by active desc, item_code
    limit ${PICKER_LIMIT}`
  return rows.map((row) => ({
    itemCode: String(row.item_code),
    itemName: String(row.item_name ?? ''),
    groupCode: numOrNull(row.group_code),
    groupName: text(row.group_name),
    category: text(row.category),
    materialRole: text(row.material_role),
    uomRaw: text(row.uom_raw),
    uom: text(row.uom),
    uomInferred: Boolean(row.uom_inferred),
    pcsPerCarton: numOrNull(row.pcs_per_carton),
    packGrams: numOrNull(row.pack_grams),
    gstRate: numOrNull(row.gst_rate),
    batchManaged: Boolean(row.batch_managed),
    hasBom: Boolean(row.has_bom),
    active: Boolean(row.active),
  }))
}

/** A party row without its balance (finance), for everyone below the manager. */
export function withoutBalance(row: PartyRow): Omit<PartyRow, 'balance'> {
  const { balance: _balance, ...rest } = row
  return rest
}

/** Customers and suppliers whose code, name, GSTIN or PAN matches; top 50. */
export async function searchParties(sql: SapSql, q?: string | null): Promise<PartyRow[]> {
  const like = searchPattern(q)
  const rows = await sql`
    select card_code, card_name, card_type, group_name, pan, gstin, city, state, phone, mobile, email, balance, active
    from erp.parties
    ${
      like
        ? sql`where card_code ilike ${like} or card_name ilike ${like} or gstin ilike ${like} or pan ilike ${like}`
        : sql``
    }
    order by active desc, card_name, card_code
    limit ${PICKER_LIMIT}`
  return rows.map((row) => ({
    cardCode: String(row.card_code),
    cardName: String(row.card_name ?? ''),
    cardType: String(row.card_type),
    groupName: text(row.group_name),
    pan: text(row.pan),
    gstin: text(row.gstin),
    city: text(row.city),
    state: text(row.state),
    phone: text(row.phone),
    mobile: text(row.mobile),
    email: text(row.email),
    balance: row.balance == null ? null : num(row.balance),
    active: Boolean(row.active),
  }))
}

export type BomLine = {
  componentCode: string
  componentName: string
  materialRole: string | null
  uom: string | null
  qtyPerBasis: number
  qtyPerUnit: number
  issueMethod: string
  isPlaceholder: boolean
}

/** The bill of materials of a finished good: quantities per basis (often 10,000 pcs) and per piece. */
export async function bomFor(sql: SapSql, itemCode: string): Promise<{ basisQty: number; lines: BomLine[] } | null> {
  const rows = await sql`
    select basis_qty, component_code, component_name, material_role, uom, qty_per_basis, qty_per_unit, issue_method,
           is_placeholder
    from erp.bom_lines where fg_item_code = ${itemCode}
    order by line_num`
  if (rows.length === 0) return null
  return {
    basisQty: num(rows[0]?.basis_qty),
    lines: rows.map((row) => ({
      componentCode: String(row.component_code),
      componentName: String(row.component_name ?? ''),
      materialRole: text(row.material_role),
      uom: text(row.uom),
      qtyPerBasis: num(row.qty_per_basis),
      qtyPerUnit: num(row.qty_per_unit),
      issueMethod: String(row.issue_method),
      isPlaceholder: Boolean(row.is_placeholder),
    })),
  }
}

/** The SAP cards of a party group: its card codes plus every card whose bill-to GSTIN carries one of its PANs. */
export async function cardCodesForParty(
  sql: SapSql,
  party: { pans: readonly string[]; cardCodes: readonly string[] },
): Promise<string[]> {
  if (party.pans.length === 0 && party.cardCodes.length === 0) return []
  const rows = await sql`
    select card_code from erp.parties
    where pan = any(${textArray(party.pans)}::text[]) or card_code = any(${textArray(party.cardCodes)}::text[])
    order by card_code`
  return rows.map((row) => String(row.card_code))
}

/** Which of these item codes exist, with their names. */
export async function itemsByCode(sql: SapSql, codes: readonly string[]): Promise<Array<{ itemCode: string; itemName: string }>> {
  if (codes.length === 0) return []
  const rows = await sql`
    select item_code, item_name from erp.items where upper(item_code) = any(${textArray(codes.map((code) => code.toUpperCase()))}::text[])`
  return rows.map((row) => ({ itemCode: String(row.item_code), itemName: String(row.item_name ?? '') }))
}

/** Which of these card codes exist, with their names. */
export async function partiesByCode(sql: SapSql, codes: readonly string[]): Promise<Array<{ cardCode: string; cardName: string }>> {
  if (codes.length === 0) return []
  const rows = await sql`
    select card_code, card_name from erp.parties where upper(card_code) = any(${textArray(codes.map((code) => code.toUpperCase()))}::text[])`
  return rows.map((row) => ({ cardCode: String(row.card_code), cardName: String(row.card_name ?? '') }))
}

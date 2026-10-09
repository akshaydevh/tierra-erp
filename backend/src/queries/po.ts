import { day, num, numOrNull, text, textArray, type SapSql } from '../sap/db'

/** SAP reads for PO intake and the inventory check (plan §P3). Everything here reads erp views only. */

export type ItemFacts = {
  itemCode: string
  itemName: string
  role: string | null
  uom: string | null
  pcsPerCarton: number | null
  packGrams: number | null
  active: boolean
  hasBom: boolean
}

export async function itemFacts(sql: SapSql, codes: readonly string[]): Promise<Record<string, ItemFacts>> {
  if (codes.length === 0) return {}
  const rows = await sql`
    select item_code, item_name, material_role, uom, pcs_per_carton, pack_grams, active, has_bom
    from erp.items where item_code = any(${textArray(codes)}::text[])`
  return Object.fromEntries(
    rows.map((row) => [
      String(row.item_code),
      {
        itemCode: String(row.item_code),
        itemName: String(row.item_name ?? ''),
        role: text(row.material_role),
        uom: text(row.uom),
        pcsPerCarton: numOrNull(row.pcs_per_carton),
        packGrams: numOrNull(row.pack_grams),
        active: Boolean(row.active),
        hasBom: Boolean(row.has_bom),
      },
    ]),
  )
}

export type BomRow = {
  componentCode: string
  basisQty: number
  qtyPerBasis: number
  issueMethod: 'manual' | 'backflush'
  isPlaceholder: boolean
}

/** Single-level BOM rows of each finished good. */
export async function bomRows(sql: SapSql, fgCodes: readonly string[]): Promise<Record<string, BomRow[]>> {
  if (fgCodes.length === 0) return {}
  const rows = await sql`
    select fg_item_code, component_code, basis_qty, qty_per_basis, issue_method, is_placeholder
    from erp.bom_lines where fg_item_code = any(${textArray(fgCodes)}::text[])
    order by fg_item_code, line_num`
  const out: Record<string, BomRow[]> = {}
  for (const row of rows) {
    const fg = String(row.fg_item_code)
    ;(out[fg] ??= []).push({
      componentCode: String(row.component_code),
      basisQty: num(row.basis_qty),
      qtyPerBasis: num(row.qty_per_basis),
      issueMethod: row.issue_method === 'backflush' ? 'backflush' : 'manual',
      isPlaceholder: Boolean(row.is_placeholder),
    })
  }
  return out
}

export type StockTotals = { onHand: number; committed: number; onOrder: number }

/** On hand, committed (SAP's open SOs / released production) and on order, summed over warehouses. */
export async function stockTotals(sql: SapSql, codes: readonly string[]): Promise<Record<string, StockTotals>> {
  if (codes.length === 0) return {}
  const rows = await sql`
    select item_code, sum(on_hand) as on_hand, sum(committed) as committed, sum(on_order) as on_order
    from erp.stock where item_code = any(${textArray(codes)}::text[])
    group by item_code`
  return Object.fromEntries(
    rows.map((row) => [
      String(row.item_code),
      { onHand: num(row.on_hand), committed: num(row.committed), onOrder: num(row.on_order) },
    ]),
  )
}

export type Ownership = { customerSupplied: boolean; ownerCardCode: string | null; ownerName: string | null }

export async function ownershipFor(sql: SapSql, codes: readonly string[]): Promise<Record<string, Ownership>> {
  if (codes.length === 0) return {}
  const rows = await sql`
    select item_code, customer_supplied, owner_card_code, owner_name
    from erp.item_ownership where item_code = any(${textArray(codes)}::text[])`
  return Object.fromEntries(
    rows.map((row) => [
      String(row.item_code),
      {
        customerSupplied: Boolean(row.customer_supplied),
        ownerCardCode: text(row.owner_card_code),
        ownerName: text(row.owner_name),
      },
    ]),
  )
}

/** Open purchase orders bringing each item in, newest due first: "PO/26-27/112". */
export async function openPurchases(sql: SapSql, codes: readonly string[]): Promise<Record<string, string[]>> {
  if (codes.length === 0) return {}
  const rows = await sql`
    select l.item_code, array_agg(distinct h.doc_no) as doc_nos
    from erp.purchase_order_lines l
    join erp.purchase_orders h on h.doc_entry = l.doc_entry
    where l.item_code = any(${textArray(codes)}::text[]) and h.status = 'open' and l.line_status = 'open' and l.open_qty > 0
    group by l.item_code`
  return Object.fromEntries(rows.map((row) => [String(row.item_code), (row.doc_nos as string[]).slice(0, 5)]))
}

/**
 * Actual material use per finished piece over the 90 days to `asOf`: issued quantity / completed quantity on the
 * production orders of each finished good. The fallback when a BOM line is a placeholder.
 */
export async function usagePerPiece(
  sql: SapSql,
  fgCodes: readonly string[],
  asOf: string,
): Promise<Record<string, Record<string, number>>> {
  if (fgCodes.length === 0) return {}
  const rows = await sql`
    with runs as (
      select doc_entry, item_code, completed_qty from erp.production_orders
      where item_code = any(${textArray(fgCodes)}::text[]) and type = 'standard' and status <> 'cancelled'
        and completed_qty > 0 and post_date > ${asOf}::date - 90 and post_date <= ${asOf}::date
    ), made as (select item_code, sum(completed_qty) as pcs from runs group by item_code)
    select r.item_code as fg, c.item_code as component, sum(c.issued_qty) / max(m.pcs) as per_piece
    from runs r
    join made m on m.item_code = r.item_code
    join erp.production_components c on c.doc_entry = r.doc_entry
    where c.issued_qty > 0
    group by r.item_code, c.item_code`
  const out: Record<string, Record<string, number>> = {}
  for (const row of rows) (out[String(row.fg)] ??= {})[String(row.component)] = num(row.per_piece)
  return out
}

export type AddressCandidate = {
  cardCode: string
  cardName: string
  addressType: 'bill_to' | 'ship_to'
  street: string | null
  city: string | null
  zipCode: string | null
  pan: string | null
}

/** Customer cards with an address registered under this GSTIN (several branch cards can share one). */
export async function cardsForGstin(sql: SapSql, gstin: string): Promise<AddressCandidate[]> {
  const rows = await sql`
    select a.card_code, a.card_name, a.address_type, a.street, a.city, a.zip_code, p.pan
    from erp.party_addresses a
    left join erp.parties p on p.card_code = a.card_code
    where a.gstin = ${gstin.toUpperCase()} and a.card_type = 'customer'
    order by a.card_code, a.address_type desc`
  return rows.map((row) => ({
    cardCode: String(row.card_code),
    cardName: String(row.card_name ?? ''),
    addressType: row.address_type === 'bill_to' ? 'bill_to' : 'ship_to',
    street: text(row.street),
    city: text(row.city),
    zipCode: text(row.zip_code),
    pan: text(row.pan),
  }))
}

export type CardInfo = { cardCode: string; cardName: string; pan: string | null; gstin: string | null }

export async function cardInfo(sql: SapSql, codes: readonly string[]): Promise<Record<string, CardInfo>> {
  if (codes.length === 0) return {}
  const rows = await sql`
    select card_code, card_name, pan, gstin from erp.parties where card_code = any(${textArray(codes)}::text[])`
  return Object.fromEntries(
    rows.map((row) => [
      String(row.card_code),
      { cardCode: String(row.card_code), cardName: String(row.card_name ?? ''), pan: text(row.pan), gstin: text(row.gstin) },
    ]),
  )
}

/**
 * Which of these cards took sales orders whose customer PO number starts like this one (same length, same first
 * `prefix` characters), most recent first: a customer numbers its POs per buying unit.
 */
export async function cardsByPoPrefix(
  sql: SapSql,
  cards: readonly string[],
  poNo: string,
  prefix = 4,
): Promise<Array<{ cardCode: string; orders: number; lastDate: string | null }>> {
  if (cards.length === 0 || poNo.length < prefix) return []
  const rows = await sql`
    select card_code, count(*) as n, max(doc_date) as last_date
    from erp.sales_orders
    where card_code = any(${textArray(cards)}::text[]) and status <> 'cancelled'
      and length(customer_po_no) = ${poNo.length} and left(customer_po_no, ${prefix}) = ${poNo.slice(0, prefix)}
    group by card_code
    order by max(doc_date) desc`
  return rows.map((row) => ({ cardCode: String(row.card_code), orders: num(row.n), lastDate: day(row.last_date) }))
}

export type SapOrderForPo = {
  docEntry: number
  docNo: string
  docDate: string | null
  cardCode: string
  status: string
  invoices: string[]
}

/** SAP sales orders that carry this customer PO number, optionally only on some cards. */
export async function sapOrdersForPo(sql: SapSql, poNo: string, cards: readonly string[] | null): Promise<SapOrderForPo[]> {
  const rows = await sql`
    select s.doc_entry, s.doc_no, s.doc_date, s.card_code, s.status,
           coalesce((select array_agg(i.doc_no order by i.doc_date, i.doc_no) from erp.invoices i
                     where s.doc_entry = any(i.so_doc_entries) and not i.cancelled and not i.is_cancellation), '{}') as invoices
    from erp.sales_orders s
    where s.customer_po_no = ${poNo}
      ${cards ? sql`and s.card_code = any(${textArray(cards)}::text[])` : sql``}
    order by s.doc_date, s.doc_entry`
  return rows.map((row) => ({
    docEntry: num(row.doc_entry),
    docNo: String(row.doc_no),
    docDate: day(row.doc_date),
    cardCode: String(row.card_code),
    status: String(row.status),
    invoices: (row.invoices as string[]) ?? [],
  }))
}

export type HistoryItem = { itemCode: string; itemName: string; packGrams: number | null; descriptions: string[] }

/** The finished goods these cards have ordered, with every description the SO lines printed for them. */
export async function customerItemHistory(sql: SapSql, cards: readonly string[]): Promise<HistoryItem[]> {
  if (cards.length === 0) return []
  const rows = await sql`
    select l.item_code, i.item_name, i.pack_grams, array_agg(distinct l.item_name) as descriptions
    from erp.sales_order_lines l
    join erp.sales_orders s on s.doc_entry = l.doc_entry
    join erp.items i on i.item_code = l.item_code
    where s.card_code = any(${textArray(cards)}::text[]) and i.material_role = 'fg'
    group by l.item_code, i.item_name, i.pack_grams`
  return rows.map((row) => ({
    itemCode: String(row.item_code),
    itemName: String(row.item_name ?? ''),
    packGrams: numOrNull(row.pack_grams),
    descriptions: ((row.descriptions as Array<string | null>) ?? []).filter((value): value is string => Boolean(value)),
  }))
}

/** Active finished goods of one pack size, for the name fallback. */
export async function fgByPackGrams(sql: SapSql, grams: number): Promise<HistoryItem[]> {
  const rows = await sql`
    select item_code, item_name, pack_grams from erp.items
    where material_role = 'fg' and active and pack_grams = ${grams}
    order by item_code
    limit 200`
  return rows.map((row) => ({
    itemCode: String(row.item_code),
    itemName: String(row.item_name ?? ''),
    packGrams: numOrNull(row.pack_grams),
    descriptions: [],
  }))
}

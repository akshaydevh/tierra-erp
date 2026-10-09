import { num, numOrNull, pageRequest, searchPattern, text, textArray, type Paged, type SapSql } from '../sap/db'

export const INVENTORY_TABS = ['fg', 'materials'] as const
export type InventoryTab = (typeof INVENTORY_TABS)[number]

/** The finished-goods store; finished goods sitting elsewhere count as finished goods too. */
export const FG_WAREHOUSE = 'FG01'

export type StockRow = {
  itemCode: string
  itemName: string
  materialRole: string | null
  uom: string | null
  uomInferred: boolean
  whsCode: string
  onHand: number
  committed: number
  free: number
  onOrder: number
  value: number | null
  ownerName: string | null
  customerSupplied: boolean
}

export type InventoryKpis = {
  fgItems: number
  fgShort: number
  materialsBelowZero: number
  customerSuppliedItems: number
}

export type InventoryPage = Paged<StockRow> & {
  kpis: InventoryKpis
  roleCounts: Record<string, number>
}

export type InventoryFilter = {
  tab?: InventoryTab
  role?: string | null
  q?: string | null
  page?: string | number | null
  pageSize?: string | number | null
}

function isFg(sql: SapSql) {
  return sql`(s.whs_code = ${FG_WAREHOUSE} or i.material_role = 'fg')`
}

export async function inventoryKpis(sql: SapSql): Promise<InventoryKpis> {
  const [row] = await sql`
    select count(distinct s.item_code) filter (where ${isFg(sql)}) as fg_items,
           count(distinct s.item_code) filter (where ${isFg(sql)} and s.free < 0) as fg_short,
           count(distinct s.item_code) filter (where not ${isFg(sql)} and s.on_hand < 0) as materials_below_zero,
           count(distinct s.item_code) filter (where s.customer_supplied) as customer_supplied_items
    from erp.stock s
    left join erp.items i on i.item_code = s.item_code`
  return {
    fgItems: num(row?.fg_items),
    fgShort: num(row?.fg_short),
    materialsBelowZero: num(row?.materials_below_zero),
    customerSuppliedItems: num(row?.customer_supplied_items),
  }
}

/** Stock per item and warehouse: finished goods or materials, optionally one material role and a search. */
export async function inventory(sql: SapSql, filter: InventoryFilter = {}): Promise<InventoryPage> {
  const tab = filter.tab ?? 'fg'
  const like = searchPattern(filter.q)
  const role = tab === 'materials' && filter.role ? filter.role : null
  const { page, pageSize, offset } = pageRequest(filter.page, filter.pageSize)
  const inTab = tab === 'fg' ? isFg(sql) : sql`not ${isFg(sql)}`
  const matches = like ? sql`and (s.item_code ilike ${like} or i.item_name ilike ${like})` : sql``
  const ofRole = role ? sql`and coalesce(i.material_role, 'other') = ${role}` : sql``

  const [rows, [count], roles, kpis] = await Promise.all([
    sql`
      select s.item_code, i.item_name, i.material_role, i.uom, i.uom_inferred, s.whs_code, s.on_hand, s.committed,
             s.free, s.on_order, s.value, s.owner_name, s.customer_supplied
      from erp.stock s
      left join erp.items i on i.item_code = s.item_code
      where ${inTab} ${matches} ${ofRole}
      order by s.item_code, s.whs_code
      limit ${pageSize} offset ${offset}`,
    sql`
      select count(*) as total
      from erp.stock s
      left join erp.items i on i.item_code = s.item_code
      where ${inTab} ${matches} ${ofRole}`,
    sql`
      select coalesce(i.material_role, 'other') as role, count(*) as n
      from erp.stock s
      left join erp.items i on i.item_code = s.item_code
      where ${inTab} ${matches}
      group by 1`,
    inventoryKpis(sql),
  ])
  return {
    kpis,
    roleCounts: Object.fromEntries(roles.map((row) => [String(row.role), num(row.n)])),
    rows: rows.map((row) => ({
      itemCode: String(row.item_code),
      itemName: String(row.item_name ?? ''),
      materialRole: text(row.material_role),
      uom: text(row.uom),
      uomInferred: Boolean(row.uom_inferred),
      whsCode: String(row.whs_code),
      onHand: num(row.on_hand),
      committed: num(row.committed),
      free: num(row.free),
      onOrder: num(row.on_order),
      value: numOrNull(row.value),
      ownerName: text(row.owner_name),
      customerSupplied: Boolean(row.customer_supplied),
    })),
    total: num(count?.total),
    page,
    pageSize,
  }
}

export type FgShortRow = {
  itemCode: string
  itemName: string
  whsCode: string
  onHand: number
  committed: number
  free: number
}

/** Finished-goods stock rows with more committed than on hand, most short first. */
export async function fgShortRows(sql: SapSql, limit: number): Promise<FgShortRow[]> {
  const rows = await sql`
    select s.item_code, i.item_name, s.whs_code, s.on_hand, s.committed, s.free
    from erp.stock s
    left join erp.items i on i.item_code = s.item_code
    where ${isFg(sql)} and s.free < 0
    order by s.free, s.item_code, s.whs_code
    limit ${limit}`
  return rows.map((row) => ({
    itemCode: String(row.item_code),
    itemName: String(row.item_name ?? ''),
    whsCode: String(row.whs_code),
    onHand: num(row.on_hand),
    committed: num(row.committed),
    free: num(row.free),
  }))
}

export type ItemStock = {
  itemCode: string
  itemName: string
  materialRole: string | null
  uom: string | null
  onHand: number
  committed: number
  free: number
  onOrder: number
  ownerName: string | null
  customerSupplied: boolean
  warehouses: Array<{ whsCode: string; onHand: number; committed: number; free: number; onOrder: number }>
}

/**
 * Stock of the given items (exact codes) or of the items whose code or name matches q, summed over warehouses
 * with the per-warehouse rows. free = on hand - committed (SAP's open sales-order commitments).
 */
export async function stockByItem(
  sql: SapSql,
  search: { itemCodes?: readonly string[]; q?: string | null; limit?: number },
): Promise<{ rows: ItemStock[]; total: number }> {
  const like = searchPattern(search.q)
  const codes = search.itemCodes?.filter(Boolean) ?? []
  if (codes.length === 0 && !like) return { rows: [], total: 0 }
  const match = codes.length > 0
    ? sql`i.item_code = any(${textArray(codes)}::text[])`
    : sql`(i.item_code ilike ${like} or i.item_name ilike ${like})`
  const items = await sql`
    select i.item_code, i.item_name, i.material_role, i.uom, count(*) over () as total
    from erp.items i
    where ${match} and exists (select 1 from erp.stock s where s.item_code = i.item_code)
    order by i.active desc, i.item_code
    limit ${search.limit ?? 10}`
  if (items.length === 0) return { rows: [], total: 0 }
  const stock = await sql`
    select item_code, whs_code, on_hand, committed, free, on_order, owner_name, customer_supplied
    from erp.stock
    where item_code = any(${textArray(items.map((row) => String(row.item_code)))}::text[])
    order by item_code, whs_code`
  return {
    total: num(items[0]?.total),
    rows: items.map((item) => {
      const rows = stock.filter((row) => row.item_code === item.item_code)
      const sum = (key: string) => rows.reduce((total, row) => total + num(row[key]), 0)
      return {
        itemCode: String(item.item_code),
        itemName: String(item.item_name ?? ''),
        materialRole: text(item.material_role),
        uom: text(item.uom),
        onHand: sum('on_hand'),
        committed: sum('committed'),
        free: sum('free'),
        onOrder: sum('on_order'),
        ownerName: text(rows.find((row) => row.owner_name)?.owner_name),
        customerSupplied: rows.some((row) => Boolean(row.customer_supplied)),
        warehouses: rows.map((row) => ({
          whsCode: String(row.whs_code),
          onHand: num(row.on_hand),
          committed: num(row.committed),
          free: num(row.free),
          onOrder: num(row.on_order),
        })),
      }
    }),
  }
}

import { numOrNull, text, textArray, type SapSql } from '../sap/db'

/** SAP reads for raising and printing a Tierra sales order (plan §P4). erp views only. */

export type ItemTax = { itemCode: string; itemName: string; hsn: string | null; gstRate: number | null; pcsPerCarton: number | null }

/** HSN as SAP prints it on invoices (OITM.ChapterID -> OCHP) and the GST rate per item. */
export async function itemTax(sql: SapSql, codes: readonly string[]): Promise<Record<string, ItemTax>> {
  if (codes.length === 0) return {}
  const rows = await sql`
    select item_code, item_name, hsn, gst_rate, pcs_per_carton from erp.items where item_code = any(${textArray(codes)}::text[])`
  return Object.fromEntries(
    rows.map((row) => [
      String(row.item_code),
      {
        itemCode: String(row.item_code),
        itemName: String(row.item_name ?? ''),
        hsn: text(row.hsn),
        gstRate: numOrNull(row.gst_rate),
        pcsPerCarton: numOrNull(row.pcs_per_carton),
      },
    ]),
  )
}

export type PartyAddress = {
  type: 'bill_to' | 'ship_to'
  name: string | null
  street: string | null
  city: string | null
  zipCode: string | null
  state: string | null
  gstin: string | null
  isDefault: boolean
}

export type PartyCard = {
  cardCode: string
  cardName: string
  gstin: string | null
  phone: string | null
  email: string | null
  addresses: PartyAddress[]
}

/** A customer card with its bill-to and ship-to addresses (CRD1 B and S rows). */
export async function partyCard(sql: SapSql, cardCode: string): Promise<PartyCard | null> {
  const [party] = await sql`
    select card_code, card_name, gstin, coalesce(mobile, phone) as phone, email from erp.parties where card_code = ${cardCode}`
  if (!party) return null
  const rows = await sql`
    select address_type, address_name, street, city, zip_code, state, gstin, is_default
    from erp.party_addresses where card_code = ${cardCode} and coalesce(active, true)
    order by address_type, is_default desc, address_name`
  return {
    cardCode: String(party.card_code),
    cardName: String(party.card_name ?? ''),
    gstin: text(party.gstin),
    phone: text(party.phone),
    email: text(party.email),
    addresses: rows.map((row) => ({
      type: row.address_type === 'bill_to' ? 'bill_to' : 'ship_to',
      name: text(row.address_name),
      street: text(row.street),
      city: text(row.city),
      zipCode: text(row.zip_code),
      state: text(row.state),
      gstin: text(row.gstin),
      isDefault: Boolean(row.is_default),
    })),
  }
}

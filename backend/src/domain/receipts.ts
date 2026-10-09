/**
 * "received 20 kg ZPMLMA, 160 kg ZOILP": material that has arrived before SAP knows (plan §P4 record_receipt).
 * Each part is a quantity, an optional unit and an item code. Units are spelt as SAP spells them (erp.items.uom):
 * kg, nos, pcs, ltr, kl, rolls.
 */

export type ReceiptLine = { qty: number; unit: string | null; itemCode: string }

const LEAD = /^(?:received|recd\.?|rcvd\.?|got)\b[\s:]*([\s\S]+)$/i
const PART = /^(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*([a-z]+)?\s+(?:of\s+)?([A-Z][A-Z0-9-]{3,})$/i

const UNITS: Record<string, string> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg',
  nos: 'nos', no: 'nos', pcs: 'pcs', pc: 'pcs', pieces: 'pcs', piece: 'pcs',
  l: 'ltr', lt: 'ltr', ltr: 'ltr', ltrs: 'ltr', litre: 'ltr', litres: 'ltr', liter: 'ltr', liters: 'ltr',
  kl: 'kl', rolls: 'rolls', roll: 'rolls',
}

/** "Kgs" -> kg, "litres" -> ltr; unknown units are kept, lower case. */
export function normaliseUnit(unit: string | null | undefined): string | null {
  const clean = unit?.trim().toLowerCase()
  return clean ? (UNITS[clean] ?? clean) : null
}

/** The receipt lines of a "received ..." message; null when the message is not one, [] when nothing parses. */
export function parseReceipt(text: string): ReceiptLine[] | null {
  const match = LEAD.exec(text.trim())
  if (!match) return null
  const lines: ReceiptLine[] = []
  // a comma between parts, never inside a number (1,500 nos)
  for (const raw of match[1]!.split(/\s*(?:(?<!\d),|,(?!\d)|;|\band\b|\n|&)\s*/i)) {
    const part = PART.exec(raw.trim().replace(/[.]$/, ''))
    if (!part) continue
    const unit = normaliseUnit(part[2])
    lines.push({ qty: Number(part[1]!.replace(/,/g, '')), unit, itemCode: part[3]!.toUpperCase() })
  }
  return lines
}

/** Whether a typed unit fits the unit SAP counts the item in (pieces and nos are the same thing). */
export function unitFits(typed: string | null, itemUom: string | null): boolean {
  if (!typed || !itemUom) return true
  const same = (unit: string) => {
    const clean = normaliseUnit(unit) ?? unit
    return clean === 'nos' ? 'pcs' : clean
  }
  return same(typed) === same(itemUom)
}

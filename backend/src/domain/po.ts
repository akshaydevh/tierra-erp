import { z } from 'zod'

/**
 * A customer purchase order as a reader returns it (v2): pages 1-2 only. Quantities are as printed: `qty` in the
 * buyer's unit (CRT, C01, EA ...) and `eaQty` from the EA sub-row when the PO prints one. Amounts are rupees.
 */
export const extractedLineSchema = z.object({
  lineNo: z.number().int().positive(),
  articleNo: z.string().nullable(),
  ean: z.string().nullable(),
  description: z.string().min(1),
  hsn: z.string().nullable(),
  qty: z.number().positive(),
  uom: z.string().nullable(),
  eaQty: z.number().positive().nullable(),
  /** MRP per buyer unit, and per piece from the EA sub-row. */
  mrp: z.number().nullable(),
  eaMrp: z.number().nullable(),
  /** Base cost per buyer unit, before tax. */
  baseCost: z.number().nullable(),
  /** Total GST % on the line (CGST + SGST, or IGST), without cess. */
  gstPct: z.number().nullable(),
  /** All tax on the line: GST and any cess. */
  taxAmount: z.number().nullable(),
  /** Cess on the line (percentage and fixed), when the PO prints it; part of taxAmount. */
  cessAmount: z.number().nullable().optional(),
  /** Total base value of the line, before tax. */
  lineTotal: z.number().nullable(),
  deliveryDate: z.string().nullable(),
})

export const extractedPoSchema = z.object({
  poNumber: z.string().min(1),
  poDate: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  /** The company that issued the PO. Tierra is the vendor, never the buyer. */
  buyerName: z.string().nullable(),
  /** The buyer's own person / desk code, e.g. a replenishment buyer id. */
  buyerCode: z.string().nullable(),
  /** Tierra's vendor code at this customer. */
  vendorCode: z.string().nullable(),
  siteCode: z.string().nullable(),
  shipToGstin: z.string().nullable(),
  shipToAddress: z.string().nullable(),
  basicTotal: z.number().nullable(),
  taxTotal: z.number().nullable(),
  total: z.number().nullable(),
  notes: z.array(z.string()),
  /** "DDP - Delivered Duty Paid", as printed; absent when the PO does not say. */
  deliveryTerm: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  lines: z.array(extractedLineSchema).min(1).max(60),
})

export type ExtractedLine = z.infer<typeof extractedLineSchema>
export type ExtractedPo = z.infer<typeof extractedPoSchema>

export type PoReader = 'z_mat_poprint' | 'llm'

/** What reading a received PDF found. */
export type PoRead =
  | { kind: 'not_po'; reason: string }
  | { kind: 'po'; po: ExtractedPo; reader: PoReader }
  | { kind: 'unreadable'; reason: string; poNumber: string | null; reader: PoReader | null }

export function isPurchaseOrderText(text: string): boolean {
  return /\bpurchase\s+order\b/i.test(text)
}

/** "PO NO.: 4400012345", "PO Number 7781", "Purchase Order No: AM/PO/7781" (first page). */
const PO_NUMBER = /\b(?:P\.?\s?O\.?|purchase\s+order)\s*(?:no\.?|number|num|#)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/\-]{3,29})/i

export function poNumberOnPage(text: string): string | null {
  return PO_NUMBER.exec(text)?.[1] ?? null
}

/** dd.mm.yyyy, dd/mm/yyyy or dd-mm-yyyy (Indian order) to YYYY-MM-DD; anything else null. */
export function indianDate(value: string | null | undefined): string | null {
  if (!value) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (iso) return value.trim()
  const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(value.trim())
  if (!match) return null
  const [, d, m, y] = match
  const day = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  const parsed = new Date(`${day}T00:00:00Z`)
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day ? null : day
}

/** "12,744.00" -> 12744; null when it is not a number. */
export function amount(value: string | null | undefined): number | null {
  if (value == null) return null
  const cleaned = value.replace(/[,\s₹]/g, '').replace(/^INR/i, '')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  return Number(cleaned)
}

export const TOTALS_TOLERANCE = 1

export type TotalsCheck = { ok: true } | { ok: false; reason: string }

/**
 * The totals guard: the lines' base values plus the tax must make the PO total, within ₹1. A misread quantity or
 * unit (2 CRT read as 2 pieces) breaks the sum, so the PO goes to a person instead of on to a check.
 */
export function checkTotals(po: ExtractedPo): TotalsCheck {
  if (po.total == null) return { ok: false, reason: 'The PO total could not be read.' }
  const missing = po.lines.filter((line) => line.lineTotal == null).map((line) => line.lineNo)
  if (missing.length) return { ok: false, reason: `Line ${missing.join(', ')} has no value.` }
  const base = po.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0)
  const lineTax = po.lines.every((line) => line.taxAmount != null)
    ? po.lines.reduce((sum, line) => sum + (line.taxAmount ?? 0), 0)
    : null
  const tax = po.taxTotal ?? lineTax
  if (tax == null) return { ok: false, reason: 'The PO tax could not be read.' }
  const sum = base + tax
  if (Math.abs(sum - po.total) > TOTALS_TOLERANCE) {
    return {
      ok: false,
      reason: `The lines (${base.toFixed(2)}) plus tax (${tax.toFixed(2)}) make ${sum.toFixed(2)}, not the PO total ${po.total.toFixed(2)}.`,
    }
  }
  return { ok: true }
}

export function receivedReply(fileName: string): string {
  return `Received ${fileName}. The Tierra team will confirm shortly.`
}

/** What a customer group sees when its PO arrives: nothing about stock, price or other customers. */
export function groupReceivedReply(poNo: string | null): string {
  return poNo ? `Received PO ${poNo}. We'll confirm shortly.` : `Received your PO. We'll confirm shortly.`
}

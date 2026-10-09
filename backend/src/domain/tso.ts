import type { CustomerPo, InventoryCheck, NewSalesOrder, SalesOrderLine, TaxKind } from '../db/types'
import { financialYear } from '../sap/db'

/**
 * A Tierra sales order from a checked customer PO (plan §P4, po-flow.md §8), decided from data only:
 * - each line keeps the PO's base value, so the SO matches the PO to the paisa; the piece price has 4 decimals
 *   (2,031.36 per carton of 56 = 36.2743);
 * - HSN comes from SAP (OITM -> OCHP); a different HSN on the PO is kept as an internal warning, never printed;
 * - GST is CGST + SGST inside Kerala (state code 32) and IGST outside, by the ship-to state; with no GSTIN on the PO
 *   or the SAP card the state is unknown, and the TSO is not raised (never guessed as Kerala);
 * - cess on the PO is carried as its own amount, so the TSO adds up to the PO;
 * - finished pieces taken from free stock are reserved on the line; the rest is to make.
 * Problems block the TSO (the PO goes to the office); warnings are only shown to the admin.
 */

export const TIERRA_STATE_CODE = '32'
export const TSO_SERIES = 'TSO'

const STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka',
  '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry',
  '35': 'Andaman and Nicobar Islands', '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh',
}

export function stateName(code: string | null): string | null {
  return code ? (STATES[code] ?? null) : null
}

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10_000) / 10_000
}

/** Units customers order cartons in. */
const CARTON_UNITS = /^(crt|c\d{2}|ctn|cs|case|box|carton)s?$/i

export type ItemTaxFacts = Record<string, { hsn: string | null; gstRate: number | null; pcsPerCarton: number | null; itemName: string }>

export type BuildInput = {
  po: CustomerPo
  check: InventoryCheck
  tax: ItemTaxFacts
  /** The GSTIN of the card shipped to, when the PO has none. */
  cardGstin: string | null
  docDate: string
  createdBy: string | null
}

export type BuildResult = {
  order: NewSalesOrder
  numbering: { series: string; fy: string }
  /** Anything that makes the TSO wrong: it is not raised and the PO goes back to the office. */
  problems: string[]
  /** Worth the admin's eye, not blocking (the TSO total differs from the PO's by more than ₹1). */
  warnings: string[]
}

/** The rupee gap between a TSO and the PO it was raised from beyond which the admin is warned. */
export const TOTAL_TOLERANCE = 1

/** "TSO total ₹52,930.00 differs from the PO total ₹52,920.00 by ₹10.00", or null when within ₹1 (or no PO total). */
export function totalMismatch(orderTotal: number, poTotal: number | null): string | null {
  if (poTotal == null || Math.abs(orderTotal - poTotal) <= TOTAL_TOLERANCE) return null
  const inr = (value: number) => `₹${new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`
  return `The TSO total ${inr(orderTotal)} differs from the PO total ${inr(poTotal)} by ${inr(Math.abs(orderTotal - poTotal))}.`
}

export function buildSalesOrder(input: BuildInput): BuildResult {
  const { po, check, tax } = input
  const problems: string[] = []
  const gstin = po.shipToGstin ?? input.cardGstin
  const stateCode = gstin && /^\d{2}/.test(gstin) ? gstin.slice(0, 2) : null
  if (!stateCode) {
    problems.push('Neither the PO nor the SAP card has a GSTIN, so the place of supply (CGST + SGST or IGST) is unknown.')
  }
  const taxKind: TaxKind = stateCode && stateCode !== TIERRA_STATE_CODE ? 'igst' : 'cgst_sgst'
  const fromStockLeft = new Map(
    check.lines.filter((line) => line.kind === 'fg').map((line) => [line.itemCode, Math.max(0, line.fromStock ?? 0)]),
  )
  let cgst = 0
  let sgst = 0
  let igst = 0
  let cess = 0
  const lines: SalesOrderLine[] = []
  for (const line of po.lines) {
    if (!line.itemCode || line.pcs == null || line.pcs <= 0) {
      problems.push(`Line ${line.lineNo} has no item or piece count.`)
      continue
    }
    const facts = tax[line.itemCode]
    const pcs = line.pcs
    const amount = round2(line.lineTotal ?? (line.unitPrice ?? 0) * pcs)
    const unitPrice = line.unitPrice ?? round4(amount / pcs)
    const gstPct = line.gstPct ?? facts?.gstRate ?? 0
    if (line.gstPct == null && facts?.gstRate == null) problems.push(`Line ${line.lineNo}: no GST rate on the PO or in SAP.`)
    // The PO's own GST on the line (its tax less any cess) when it agrees with the rate (to the paisa, as the buyer
    // will check it); otherwise the GST worked out here. Cess is carried as printed.
    const cessAmount = round2(line.cessAmount ?? 0)
    const computed = taxKind === 'cgst_sgst' ? round2((amount * gstPct) / 200) * 2 : round2((amount * gstPct) / 100)
    const poGst = line.taxAmount != null ? round2(line.taxAmount - cessAmount) : null
    const taxAmount = poGst != null && Math.abs(poGst - computed) <= 0.05 ? poGst : round2(computed)
    cess += cessAmount
    if (taxKind === 'cgst_sgst') {
      const half = round2(taxAmount / 2)
      cgst += half
      sgst += round2(taxAmount - half)
    } else {
      igst += taxAmount
    }
    const perCarton = facts?.pcsPerCarton ?? null
    const cartons =
      line.uom && CARTON_UNITS.test(line.uom.trim()) && line.pcsSource !== 'pcs'
        ? line.qty
        : perCarton
          ? round2(pcs / perCarton)
          : null
    const reserved = Math.min(pcs, fromStockLeft.get(line.itemCode) ?? 0)
    fromStockLeft.set(line.itemCode, (fromStockLeft.get(line.itemCode) ?? 0) - reserved)
    const mrpPerPiece = line.mrp != null && line.pcsPerUom && line.pcsPerUom > 1 ? round2(line.mrp / line.pcsPerUom) : line.mrp
    lines.push({
      lineNo: lines.length + 1,
      itemCode: line.itemCode,
      itemName: line.itemName ?? facts?.itemName ?? null,
      description: line.description,
      articleNo: line.articleNo,
      ean: line.ean,
      hsn: facts?.hsn ?? null,
      poHsn: line.hsn,
      uom: line.uom,
      qty: line.qty,
      pcs,
      pcsPerUom: line.pcsPerUom,
      cartons,
      mrp: mrpPerPiece,
      unitPrice,
      amount,
      gstPct,
      taxAmount,
      cessAmount,
      reservedPcs: reserved,
      toMake: round4(pcs - reserved),
    })
  }
  const basicTotal = round2(lines.reduce((sum, line) => sum + line.amount, 0))
  cgst = round2(cgst)
  sgst = round2(sgst)
  igst = round2(igst)
  cess = round2(cess)
  const taxTotal = round2(cgst + sgst + igst + cess)
  const total = round2(basicTotal + taxTotal)
  const mismatch = totalMismatch(total, po.total)
  return {
    numbering: { series: TSO_SERIES, fy: financialYear(input.docDate) },
    problems,
    warnings: mismatch ? [mismatch] : [],
    order: {
      customerPoId: po.id,
      partyGroupId: po.partyGroupId,
      cardCode: po.cardCode ?? '',
      checkId: check.id,
      status: 'pending_approval',
      docDate: input.docDate,
      deliveryDate: po.deliveryDate,
      customerPoNo: po.poNo,
      poDate: po.poDate,
      vendorCode: po.vendorCode,
      siteCode: po.siteCode,
      shipToGstin: po.shipToGstin,
      placeOfSupply: stateName(stateCode),
      stateCode,
      taxKind,
      basicTotal,
      cgst,
      sgst,
      igst,
      cess,
      taxTotal,
      total,
      deliveryTerm: po.deliveryTerm ?? null,
      paymentTerms: po.paymentTerms ?? null,
      notes: [...po.notes],
      createdBy: input.createdBy,
      lines,
    },
  }
}

/** "PO HSN 21069091 ≠ SAP 20081940" for each line whose PO HSN differs from SAP's (internal annex only). */
export function hsnWarnings(lines: readonly Pick<SalesOrderLine, 'lineNo' | 'itemCode' | 'hsn' | 'poHsn'>[]): string[] {
  const clean = (value: string | null) => value?.replace(/\D/g, '') ?? ''
  return lines
    .filter((line) => line.poHsn && line.hsn && clean(line.poHsn) !== clean(line.hsn))
    .map((line) => `Line ${line.lineNo} ${line.itemCode}: PO HSN ${line.poHsn} differs from SAP HSN ${line.hsn}; the SO prints SAP's.`)
}

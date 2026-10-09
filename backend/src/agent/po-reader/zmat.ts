import { amount, indianDate, type ExtractedLine, type ExtractedPo } from '../../domain/po'

/**
 * A deterministic reader for the SAP NetWeaver purchase-order print "Z_MAT_POPRINT" (a large retail chain's form), on
 * the text pdf-parse returns for pages 1-2. pdf-parse emits each line item column by column:
 *
 *   " 1 700100200"          Sr.No and Article No.
 *   " 20081940"             HSN code
 *   " 8900000000017"        EAN
 *   " ZETA ... 100 G PP"    material description
 *   " 10.03.2026" " T9QA"   delivery date, site
 *   " 3.000" " 150.000"     quantity in the buyer's unit, then the EA sub-row
 *   "CRT" "EA"              units
 *   then MRP (unit, EA), base cost, CGST %, SGST %, CESS %, CessFxdRt, CGST, SGST, CESS, CessFxdVl, total base value.
 *
 * Every line is cross-checked (qty x base cost = base value, CGST = base value x CGST %); anything that does not fit
 * returns null and the PO goes to the general reader instead. Values here never guess.
 */

const SIGNATURE_PARTS = [/Vendor Code\s*:/i, /PO NO\.?\s*:/i, /Article No\./i, /EAN No\./i, /Total Base Value/i]

/** The form name is in the PDF's Creator ("Form Z_MAT_POPRINT EN"); the text layout is checked as well. */
export function isZMatPoPrint(text: string, creator?: string | null): boolean {
  if (creator && /Z_MAT_POPRINT/i.test(creator)) return true
  return SIGNATURE_PARTS.every((part) => part.test(text))
}

const HEADER_TOKENS = new Set(
  [
    'Sr.No Article No.',
    'HSN Code',
    'EAN No.',
    'Vendor Article No.',
    'Vendor Item No',
    'Material Description',
    'Delivery Date',
    'Site',
    'SGST(%)',
    'CESS(%)',
    'CessFxdRt',
    'CGST',
    'SGST',
    'CESS',
    'CessFxdVl',
    'Total Base Value',
  ].map((token) => token.toLowerCase()),
)

const NUMBER = /^-?[\d,]+(?:\.\d+)?$/
const DATE = /^\d{2}\.\d{2}\.\d{4}$/
const UOM = /^[A-Z][A-Z0-9]{0,4}$/

function lines(text: string): string[] {
  return text.split(/\r?\n/)
}

function firstMatch(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text)
  return match?.[1]?.trim() || null
}

function isPageHeader(line: string): boolean {
  const trimmed = line.trim()
  return (
    /^PURCHASE ORDER\s+Number\s*:/i.test(trimmed) ||
    /^Po Date\s*:/i.test(trimmed) ||
    /^Page No\s*:/i.test(trimmed) ||
    /^Quantity\s*UOM/i.test(trimmed) ||
    HEADER_TOKENS.has(trimmed.toLowerCase())
  )
}

function tokensOf(block: string[]): string[] {
  return block
    .filter((line) => !isPageHeader(line))
    .flatMap((line) => line.trim().split(/\s{2,}/))
    .map((token) => token.trim())
    .filter(Boolean)
}

type RawLine = { sr: number; article: string; tokens: string[] }

/** The line-item table: from the column headers to "Grand Total of Qty", cut into blocks at "<sr> <article>". */
function rawLines(text: string): RawLine[] | null {
  const all = lines(text)
  const start = all.findIndex((line) => /^\s*Total Base Value\s*$/i.test(line))
  const end = all.findIndex((line, index) => index > start && /Grand Total of Qty/i.test(line))
  if (start < 0 || end < 0) return null
  const out: RawLine[] = []
  let current: RawLine | null = null
  for (const line of all.slice(start + 1, end)) {
    const head = /^\s*(\d{1,3})\s+(\d{5,})\s*$/.exec(line)
    if (head && (!current || Number(head[1]) === current.sr + 1)) {
      current = { sr: Number(head[1]), article: head[2]!, tokens: [] }
      out.push(current)
      continue
    }
    if (current) current.tokens.push(...tokensOf([line]))
  }
  return out.length ? out : null
}

function close(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance
}

function parseLine(raw: RawLine): ExtractedLine | null {
  let hsn: string | null = null
  let ean: string | null = null
  let description: string | null = null
  let deliveryDate: string | null = null
  let site: string | null = null
  const numbers: number[] = []
  const uoms: string[] = []
  for (const token of raw.tokens) {
    if (deliveryDate === null) {
      if (DATE.test(token)) deliveryDate = token
      else if (/^\d{13,14}$/.test(token) && !ean) ean = token
      else if (/^\d{4,8}$/.test(token) && !hsn && !description) hsn = token
      else if (/[A-Za-z]/.test(token) && !description) description = token
      else if (/[A-Za-z]/.test(token) && description) description = `${description} ${token}`
      continue
    }
    if (site === null && /^[A-Z0-9]{2,8}$/.test(token) && /[A-Z]/.test(token)) {
      site = token
      continue
    }
    if (NUMBER.test(token)) numbers.push(amount(token)!)
    else if (UOM.test(token)) uoms.push(token)
    else return null
  }
  if (!description || !deliveryDate) return null

  let qty: number
  let eaQty: number | null = null
  let mrp: number
  let eaMrp: number | null = null
  let rest: number[]
  if (uoms.length === 2 && uoms[1] === 'EA' && numbers.length === 14) {
    ;[qty, eaQty, mrp, eaMrp] = numbers as [number, number, number, number]
    rest = numbers.slice(4)
  } else if (uoms.length === 1 && numbers.length === 12) {
    ;[qty, mrp] = numbers as [number, number]
    rest = numbers.slice(2)
  } else {
    return null
  }
  const [baseCost, cgstPct, sgstPct, cessPct, , cgst, sgst, cess, cessFixed, totalBase] = rest as number[]
  if ([baseCost, cgstPct, sgstPct, cessPct, cgst, sgst, cess, cessFixed, totalBase].some((value) => value === undefined)) {
    return null
  }
  if (!(qty > 0) || !close(qty * baseCost!, totalBase!, 0.05 * Math.max(1, qty))) return null
  if (!close((totalBase! * cgstPct!) / 100, cgst!, 0.05) || !close((totalBase! * sgstPct!) / 100, sgst!, 0.05)) return null

  return {
    lineNo: raw.sr,
    articleNo: raw.article,
    ean,
    description,
    hsn,
    qty,
    uom: uoms[0]!,
    eaQty,
    mrp,
    eaMrp,
    baseCost: baseCost!,
    // GST alone; the cess (percentage and fixed) is carried separately so the sales order can print it on its own line
    gstPct: Math.round((cgstPct! + sgstPct!) * 100) / 100,
    taxAmount: Math.round((cgst! + sgst! + cess! + cessFixed!) * 100) / 100,
    ...(cess! + cessFixed! > 0 ? { cessAmount: Math.round((cess! + cessFixed!) * 100) / 100 } : {}),
    lineTotal: totalBase!,
    deliveryDate: indianDate(deliveryDate),
  }
}

/** The delivery block: from "Delivery Address :" to the "Tel :" / "GSTN No" line. */
function deliveryBlock(text: string): { address: string | null; gstin: string | null } {
  const all = lines(text)
  const start = all.findIndex((line) => /Delivery Address\s*:/i.test(line))
  if (start < 0) return { address: null, gstin: null }
  const parts: string[] = []
  let gstin: string | null = null
  for (let index = start; index < Math.min(all.length, start + 15); index += 1) {
    const line = all[index]!.trim()
    const tax = /GSTN?\s*No\.?\s*:\s*([0-9]{2}[A-Z0-9]{13})/i.exec(line)
    if (tax) {
      gstin = tax[1]!.toUpperCase()
      break
    }
    if (/^Tel\s*:/i.test(line) || /^TOTAL\b/i.test(line)) continue
    const value = (index === start ? line.replace(/^.*Delivery Address\s*:\s*/i, '') : line).replace(/^"+|"+$/g, '').trim()
    if (value) parts.push(value)
  }
  return { address: parts.length ? parts.join(', ').replace(/\s+/g, ' ') : null, gstin }
}

/** The buyer's notes: each "»" bullet with the lines that continue it, up to the GSTIN details. */
function buyerNotes(text: string): string[] {
  const notes: string[] = []
  let current: string[] | null = null
  for (const raw of lines(text)) {
    const line = raw.trim()
    if (/^GSTIN Number Details/i.test(line)) break
    if (line.startsWith('»')) {
      current = [line.replace(/^»\s*/, '')]
      notes.push('')
    } else if (current && line) {
      current.push(line)
    } else {
      continue
    }
    notes[notes.length - 1] = current.join(' ').replace(/\s+/g, ' ').trim()
  }
  return notes.filter(Boolean)
}

/** Reads a Z_MAT_POPRINT purchase order from pdf-parse text of pages 1-2; null when the text does not fit. */
export function parseZMatPoPrint(text: string): ExtractedPo | null {
  const poNumber = firstMatch(text, /PO NO\.?\s*:\s*(\d{6,})/i)
  if (!poNumber) return null
  const raw = rawLines(text)
  if (!raw) return null
  const parsed = raw.map(parseLine)
  if (parsed.some((line) => line === null)) return null
  const delivery = deliveryBlock(text)
  const cgst = amount(firstMatch(text, /TOTAL CGST\s*INR\s*([\d,]+\.\d{2})/i))
  const sgst = amount(firstMatch(text, /TOTAL SGST\s*INR\s*([\d,]+\.\d{2})/i))
  const igst = amount(firstMatch(text, /TOTAL IGST\s*INR\s*([\d,]+\.\d{2})/i))
  const taxParts = [cgst, sgst, igst].filter((value): value is number => value !== null)
  const buyerName = lines(text).map((line) => line.trim()).find(Boolean) ?? null
  const deliveryTerm = firstMatch(text, /Delivery Term\s*:\s*([^\n]+?)\s*$/im)
  const paymentTerms = firstMatch(text, /Payment Terms\s*:\s*([^\n]+?)\s*$/im)
  return {
    poNumber,
    poDate: indianDate(firstMatch(text, /PO Date\s*:\s*(\d{2}\.\d{2}\.\d{4})/i)),
    deliveryDate: indianDate(firstMatch(text, /DELIVERY DATE\s*:\s*(\d{2}\.\d{2}\.\d{4})/i)),
    buyerName,
    buyerCode: firstMatch(text, /Buyer\s*:\s*([A-Z0-9]+)/),
    vendorCode: firstMatch(text, /Vendor Code\s*:\s*([A-Z0-9]+)/i),
    siteCode: firstMatch(text, /PO NO\.?\s*:\s*\d+\s+Site\s*:\s*([A-Z0-9]+)/i) ?? firstMatch(text, /\bSite\s*:\s*([A-Z0-9]{2,8})\b/),
    shipToGstin: delivery.gstin ?? firstMatch(text, /GSTIN No\s*:\s*([0-9]{2}[A-Z0-9]{13})/i),
    shipToAddress: delivery.address,
    basicTotal: amount(firstMatch(text, /TOTAL BASIC VALUE\s*INR\s*([\d,]+\.\d{2})/i)),
    taxTotal: taxParts.length ? Math.round(taxParts.reduce((sum, value) => sum + value, 0) * 100) / 100 : null,
    total: amount(firstMatch(text, /Total Order Value\s*:?\s*INR\s*([\d,]+\.\d{2})/i)),
    notes: buyerNotes(text),
    ...(deliveryTerm ? { deliveryTerm } : {}),
    // "See Page Inside" points at the terms pages, which are not read
    ...(paymentTerms && !/see page/i.test(paymentTerms) ? { paymentTerms } : {}),
    lines: parsed as ExtractedLine[],
  }
}

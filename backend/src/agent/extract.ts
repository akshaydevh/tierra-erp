import { z } from 'zod'
import { samplingParams, type ReasoningEffort } from './model-params'
import {
  checkTotals,
  extractedPoSchema,
  indianDate,
  isPurchaseOrderText,
  poNumberOnPage,
  type ExtractedPo,
  type PoRead,
  type PoReader,
} from '../domain/po'
import { isZMatPoPrint, parseZMatPoPrint } from './po-reader/zmat'

/**
 * Reading a received PDF (plan §P3): the PO gate on the text of pages 1-2, then the deterministic Z_MAT_POPRINT
 * reader when the layout matches, else the LLM reader (zod v2 schema). Both pass the totals guard; anything that
 * fails ends as `unreadable`, which the intake turns into an office review task. Nothing here guesses a value.
 */

export class ExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractError'
  }
}

export const MODEL_TIMEOUT_MS = 90_000
/** Pages 3+ of a PO are standard terms. */
export const PO_PAGES = 2

export type ExtractEnv = {
  openaiBaseUrl: string
  openaiApiKey: string
  openaiModel: string
  /** Used only when OPENAI_MODEL is a reasoning model (gpt-5 family, o-series). */
  openaiReasoningEffort: ReasoningEffort
}

export type PdfText = { pages: string[]; creator: string | null }

type TextItem = { str: string; transform: number[] }
type PageData = { getTextContent(options: Record<string, boolean>): Promise<{ items: TextItem[] }> }

/** pdf-parse's own page renderer (one line per text row), keeping each page apart. */
export async function extractPdfPages(pdf: Buffer, maxPages = PO_PAGES): Promise<PdfText> {
  const pdfParse = (await import('pdf-parse')).default as unknown as (
    data: Buffer,
    options: { max: number; pagerender: (page: PageData) => Promise<string> },
  ) => Promise<{ text: string; info?: { Creator?: string } }>
  const pages: string[] = []
  const parsed = await pdfParse(pdf, {
    max: maxPages,
    async pagerender(page) {
      const content = await page.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
      let lastY: number | undefined
      let text = ''
      for (const item of content.items) {
        text += lastY === item.transform[5] || lastY === undefined ? item.str : `\n${item.str}`
        lastY = item.transform[5]
      }
      pages.push(text)
      return text
    },
  })
  return { pages: pages.length ? pages : [parsed.text ?? ''], creator: parsed.info?.Creator ?? null }
}

export async function extractPdfText(pdf: Buffer): Promise<string> {
  return (await extractPdfPages(pdf)).pages.join('\n\n')
}

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new ExtractError('The reader did not return purchase order JSON.')
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown
  } catch {
    throw new ExtractError('The reader did not return purchase order JSON.')
  }
}

/** The model's JSON, loosened where models differ (nulls left out, numbers as strings), then the strict v2 schema. */
const looseNumber = z.preprocess((value) => {
  if (typeof value === 'string') {
    const cleaned = value.replace(/[,₹\s]/g, '')
    return cleaned === '' ? null : Number(cleaned)
  }
  return value
}, z.number().nullable().optional())

const looseText = z.preprocess((value) => (value == null || value === '' ? null : String(value)), z.string().nullable().optional())

const modelSchema = z.object({
  poNumber: z.preprocess((value) => (value == null ? value : String(value)), z.string().min(1)),
  poDate: looseText,
  deliveryDate: looseText,
  buyerName: looseText,
  buyerCode: looseText,
  vendorCode: looseText,
  siteCode: looseText,
  shipToGstin: looseText,
  shipToAddress: looseText,
  basicTotal: looseNumber,
  taxTotal: looseNumber,
  total: looseNumber,
  notes: z.array(z.string()).nullable().optional(),
  deliveryTerm: looseText,
  paymentTerms: looseText,
  lines: z
    .array(
      z.object({
        lineNo: looseNumber,
        articleNo: looseText,
        ean: looseText,
        description: z.string().min(1),
        hsn: looseText,
        qty: z.preprocess((value) => (typeof value === 'string' ? Number(value.replace(/,/g, '')) : value), z.number().positive()),
        uom: looseText,
        eaQty: looseNumber,
        mrp: looseNumber,
        eaMrp: looseNumber,
        baseCost: looseNumber,
        gstPct: looseNumber,
        taxAmount: looseNumber,
        cessAmount: looseNumber,
        lineTotal: looseNumber,
        deliveryDate: looseText,
      }),
    )
    .min(1)
    .max(60),
})

/** The reader's JSON as an ExtractedPo v2; throws ExtractError when it does not fit. */
export function toExtractedPo(value: unknown): ExtractedPo {
  const parsed = modelSchema.safeParse(value)
  if (!parsed.success) throw new ExtractError('The purchase order could not be read.')
  const data = parsed.data
  const po: ExtractedPo = {
    poNumber: data.poNumber.trim(),
    poDate: indianDate(data.poDate ?? null),
    deliveryDate: indianDate(data.deliveryDate ?? null),
    buyerName: data.buyerName ?? null,
    buyerCode: data.buyerCode ?? null,
    vendorCode: data.vendorCode ?? null,
    siteCode: data.siteCode ?? null,
    shipToGstin: data.shipToGstin?.replace(/\s/g, '').toUpperCase() ?? null,
    shipToAddress: data.shipToAddress ?? null,
    basicTotal: data.basicTotal ?? null,
    taxTotal: data.taxTotal ?? null,
    total: data.total ?? null,
    notes: data.notes ?? [],
    ...(data.deliveryTerm ? { deliveryTerm: data.deliveryTerm } : {}),
    ...(data.paymentTerms ? { paymentTerms: data.paymentTerms } : {}),
    lines: data.lines.map((line, index) => ({
      lineNo: line.lineNo && Number.isInteger(line.lineNo) && line.lineNo > 0 ? line.lineNo : index + 1,
      articleNo: line.articleNo ?? null,
      ean: line.ean ?? null,
      description: line.description,
      hsn: line.hsn ?? null,
      qty: line.qty,
      uom: line.uom ?? null,
      eaQty: line.eaQty && line.eaQty > 0 ? line.eaQty : null,
      mrp: line.mrp ?? null,
      eaMrp: line.eaMrp ?? null,
      baseCost: line.baseCost ?? null,
      gstPct: line.gstPct ?? null,
      taxAmount: line.taxAmount ?? null,
      ...(line.cessAmount ? { cessAmount: line.cessAmount } : {}),
      lineTotal: line.lineTotal ?? null,
      deliveryDate: indianDate(line.deliveryDate ?? null),
    })),
  }
  const strict = extractedPoSchema.safeParse(po)
  if (!strict.success) throw new ExtractError('The purchase order could not be read.')
  return strict.data
}

const READER_PROMPT = [
  'You read a customer purchase order (PDF text of pages 1-2) sent to Tierra Food India, a snack factory.',
  'Tierra is the vendor and is never the buyer. Return only JSON with these keys:',
  'poNumber, poDate (YYYY-MM-DD), deliveryDate (YYYY-MM-DD), buyerName (the company that issued the PO), buyerCode,',
  "vendorCode (Tierra's vendor code at the buyer), siteCode (the buyer's site / store / DC code), shipToGstin,",
  'shipToAddress (the delivery address as one line), basicTotal, taxTotal (all GST and cess), total (order value),',
  'notes (buyer instructions, short, as an array), deliveryTerm (e.g. DDP, as printed), paymentTerms (as printed), and lines.',
  'Each line: lineNo, articleNo (buyer article / item code), ean, description, hsn, qty (as printed, in the',
  'buyer unit), uom (as printed: CRT, C01, CS, EA, PCS ...), eaQty (pieces, only when the PO prints an EA / piece',
  'sub-row or column; else null), mrp (per buyer unit), eaMrp (MRP per piece if printed), baseCost (price per buyer',
  'unit before tax), gstPct (total GST % on the line, without cess), taxAmount (total tax on the line, GST and cess),',
  'cessAmount (cess on the line, null when there is none), lineTotal (line value before tax), deliveryDate.',
  'Copy numbers exactly as printed; never compute or guess a missing value: use null.',
  'Do not invent lines that are not in the text.',
].join(' ')

async function askReader(env: ExtractEnv, text: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(`${env.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
      headers: { authorization: `Bearer ${env.openaiApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.openaiModel,
        ...samplingParams(env.openaiModel, { temperature: 0, effort: env.openaiReasoningEffort, withTools: false }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: READER_PROMPT },
          { role: 'user', content: text.slice(0, 20000) },
        ],
      }),
    })
  } catch {
    throw new ExtractError('The purchase order reader did not answer.')
  }
  if (!response.ok) throw new ExtractError(`The purchase order reader failed (${response.status}).`)
  const payload = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new ExtractError('The reader did not return purchase order JSON.')
  return content
}

/** The LLM reader for any layout without a deterministic reader. Throws ExtractError. */
export async function extractWithModel(text: string, env: ExtractEnv): Promise<ExtractedPo> {
  if (!env.openaiApiKey) {
    throw new ExtractError('This PO layout needs the AI reader, and no OpenAI key is configured.')
  }
  return toExtractedPo(parseModelJson(await askReader(env, text)))
}

function guarded(po: ExtractedPo, reader: PoReader): PoRead {
  const totals = checkTotals(po)
  if (!totals.ok) return { kind: 'unreadable', reason: totals.reason, poNumber: po.poNumber, reader }
  return { kind: 'po', po, reader }
}

/** Reads a PDF's text (pages 1-2) as a customer PO. */
export async function readPoText(text: PdfText, env: ExtractEnv): Promise<PoRead> {
  const all = text.pages.join('\n\n')
  if (all.trim().length < 20) {
    return { kind: 'unreadable', reason: 'The PDF has no readable text (a scan?).', poNumber: null, reader: null }
  }
  if (!isPurchaseOrderText(all)) return { kind: 'not_po', reason: 'The text does not say purchase order.' }
  const poNumber = poNumberOnPage(text.pages[0] ?? '')
  if (!poNumber) return { kind: 'not_po', reason: 'No PO number on page 1.' }
  if (isZMatPoPrint(all, text.creator)) {
    const po = parseZMatPoPrint(all)
    if (po) return guarded(po, 'z_mat_poprint')
  }
  try {
    return guarded(await extractWithModel(all, env), 'llm')
  } catch (error) {
    if (!(error instanceof ExtractError)) throw error
    return { kind: 'unreadable', reason: error.message, poNumber, reader: 'llm' }
  }
}

export async function readPurchaseOrder(pdf: Buffer, env: ExtractEnv): Promise<PoRead> {
  let text: PdfText
  try {
    text = await extractPdfPages(pdf)
  } catch {
    return { kind: 'unreadable', reason: 'The PDF could not be opened.', poNumber: null, reader: null }
  }
  return readPoText(text, env)
}

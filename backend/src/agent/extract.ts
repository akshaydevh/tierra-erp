import { z } from 'zod'
import { isPurchaseOrderText, type ExtractedPo } from '../domain/intake'

export class ExtractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExtractError'
  }
}

const extractedSchema = z.object({
  customerName: z.string().min(1),
  poNumber: z.string().min(1),
  poDate: z.string().nullable().optional(),
  lines: z
    .array(
      z.object({
        description: z.string().min(1),
        quantity: z.number().positive(),
        unit: z.string().nullable().optional(),
        buyerCode: z.string().nullable().optional(),
        price: z.number().nullable().optional(),
      }),
    )
    .min(1)
    .max(50),
})

export type ExtractEnv = {
  openaiBaseUrl: string
  openaiApiKey: string
  openaiModel: string
}

function dayOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

export function parseModelJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) {
    throw new ExtractError('The reader did not return purchase order JSON.')
  }
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown
  } catch {
    throw new ExtractError('The reader did not return purchase order JSON.')
  }
}

export function toExtractedPo(value: unknown): ExtractedPo {
  const parsed = extractedSchema.safeParse(value)
  if (!parsed.success) throw new ExtractError('The purchase order could not be read.')
  return {
    customerName: parsed.data.customerName,
    poNumber: parsed.data.poNumber,
    poDate: dayOrNull(parsed.data.poDate),
    lines: parsed.data.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unit: line.unit ?? null,
      buyerCode: line.buyerCode ?? null,
      price: line.price ?? null,
    })),
  }
}

export async function extractPdfText(pdf: Buffer): Promise<string> {
  const pdfParse = (await import('pdf-parse')).default as (data: Buffer) => Promise<{ text: string }>
  const parsed = await pdfParse(pdf)
  return parsed.text ?? ''
}

export async function extractPurchaseOrder(pdf: Buffer, env: ExtractEnv): Promise<ExtractedPo> {
  if (!env.openaiApiKey) {
    throw new ExtractError('OpenAI is not configured. No order was created.')
  }
  const text = (await extractPdfText(pdf)).trim()
  if (text.length < 20) {
    throw new ExtractError('The PDF had no readable text. No order was created.')
  }
  if (!isPurchaseOrderText(text)) {
    throw new ExtractError('This PDF is not a purchase order. No order was created.')
  }
  const response = await fetch(`${env.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.openaiApiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: env.openaiModel,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You extract a customer purchase order from PDF text for a snack factory. customerName is the buyer who issued the purchase order, the company named with the purchase order, not the vendor. Tierra Food India is the vendor and is never the customer. Return only JSON with keys customerName, poNumber, poDate (YYYY-MM-DD or null), and lines. Each line has description, quantity, unit, buyerCode, and price. quantity is a number. buyerCode, unit, and price may be null. Do not invent lines that are not in the text.',
        },
        { role: 'user', content: text.slice(0, 20000) },
      ],
    }),
  })
  if (!response.ok) {
    throw new ExtractError(`The purchase order reader failed (${response.status}). No order was created.`)
  }
  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new ExtractError('The reader did not return purchase order JSON.')
  return toExtractedPo(parseModelJson(content))
}
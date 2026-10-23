import { z } from 'zod'
import { samplingParams, type ReasoningEffort } from './model-params'

/**
 * Reading a photo sent on WhatsApp: one vision call that copies what is printed on a product packet (brand,
 * product, pack size, batch code, dates, MRP) into fixed fields. It only reads; find_batch then matches the code
 * against the ERP's batches, because a code read off a photo can be a character or two off. Nothing here guesses.
 */

export const PHOTO_TIMEOUT_MS = 60_000

export type PhotoEnv = {
  openaiBaseUrl: string
  openaiApiKey: string
  /** OPENAI_VISION_MODEL, else OPENAI_MODEL: it has to accept images. */
  openaiVisionModel: string
  openaiReasoningEffort: ReasoningEffort
}

export type PhotoRead = {
  /** packet: a product packet or carton label; other: anything else (a document, a screenshot, a person). */
  kind: 'packet' | 'other'
  /** clear, partly readable (glare, blur, cut off), or unreadable. */
  quality: 'clear' | 'partial' | 'unreadable'
  brand: string | null
  product: string | null
  packSize: string | null
  /** The batch / lot code exactly as printed, or null when none is visible. */
  batchNo: string | null
  /** Characters of the batch code the reader was unsure of, e.g. ["5th: I or 1"]. */
  batchNoDoubts: string[]
  mfgDate: string | null
  expDate: string | null
  bestBefore: string | null
  mrp: string | null
  /** A short description when kind is other, or anything else printed that matters (FSSAI no., net weight ...). */
  notes: string | null
}

const looseText = z.preprocess(
  (value) => (value == null || value === '' ? null : String(value).trim() || null),
  z.string().max(200).nullable().optional(),
)

const photoSchema = z.object({
  kind: z.preprocess((value) => (value === 'packet' ? 'packet' : 'other'), z.enum(['packet', 'other'])),
  quality: z.preprocess(
    (value) => (value === 'clear' || value === 'partial' || value === 'unreadable' ? value : 'partial'),
    z.enum(['clear', 'partial', 'unreadable']),
  ),
  brand: looseText,
  product: looseText,
  packSize: looseText,
  batchNo: looseText,
  batchNoDoubts: z.preprocess((value) => (Array.isArray(value) ? value.map(String).slice(0, 6) : []), z.array(z.string())),
  mfgDate: looseText,
  expDate: looseText,
  bestBefore: looseText,
  mrp: looseText,
  notes: looseText,
})

export class PhotoReadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PhotoReadError'
  }
}

const READER_PROMPT = [
  'You read a photo sent to Tierra Food India, a factory that makes banana and tapioca chips for many brands.',
  'Copy what is printed; never guess or complete text you cannot see. Return only JSON with these keys:',
  'kind ("packet" for a snack packet, pouch or carton label; else "other"),',
  'quality ("clear", "partial" when glare, blur or a fold hides some print, "unreadable"),',
  'brand, product (the product and flavour as printed, e.g. "Banana Chips Classic Salted"), packSize (net weight, e.g. "65 g"),',
  'batchNo (the batch / lot / B.No. code exactly as printed, letters and digits, no spaces; null if none is visible),',
  'batchNoDoubts (an array: each character of the batch code you are unsure of, e.g. "6th character: I or 1"; [] when sure),',
  'mfgDate, expDate, bestBefore (as printed, e.g. "07/09/26" or "Best before 6 months"), mrp (as printed),',
  'notes (one short line: for kind other what the photo shows; for a packet anything else useful such as a second code).',
  'Use null for anything not visible.',
].join(' ')

export function toPhotoRead(value: unknown): PhotoRead {
  const parsed = photoSchema.safeParse(value)
  if (!parsed.success) throw new PhotoReadError('The photo could not be read.')
  const data = parsed.data
  return {
    kind: data.kind,
    quality: data.quality,
    brand: data.brand ?? null,
    product: data.product ?? null,
    packSize: data.packSize ?? null,
    batchNo: data.batchNo ? data.batchNo.replace(/\s+/g, '').toUpperCase() : null,
    batchNoDoubts: data.batchNoDoubts,
    mfgDate: data.mfgDate ?? null,
    expDate: data.expDate ?? null,
    bestBefore: data.bestBefore ?? null,
    mrp: data.mrp ?? null,
    notes: data.notes ?? null,
  }
}

function photoJson(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) throw new PhotoReadError('The photo reader did not return JSON.')
  try {
    return JSON.parse(trimmed.slice(start, end + 1)) as unknown
  } catch {
    throw new PhotoReadError('The photo reader did not return JSON.')
  }
}

/** Reads a photo (JPEG / PNG / WebP bytes). Throws PhotoReadError. */
export async function readPhoto(image: Buffer, mimeType: string, env: PhotoEnv): Promise<PhotoRead> {
  if (!env.openaiApiKey) throw new PhotoReadError('No OpenAI key is configured, so photos cannot be read.')
  const mime = /^image\/(jpeg|png|webp|gif)$/.test(mimeType) ? mimeType : 'image/jpeg'
  let response: Response
  try {
    response = await fetch(`${env.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS),
      headers: { authorization: `Bearer ${env.openaiApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.openaiVisionModel,
        ...samplingParams(env.openaiVisionModel, { temperature: 0, effort: env.openaiReasoningEffort, withTools: false }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: READER_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Read this photo.' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${image.toString('base64')}`, detail: 'high' } },
            ],
          },
        ],
      }),
    })
  } catch {
    throw new PhotoReadError('The photo reader did not answer.')
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    console.error(`The photo reader failed (${response.status}) ${detail}`)
    throw new PhotoReadError(`The photo reader failed (${response.status}).`)
  }
  const payload = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new PhotoReadError('The photo reader did not return JSON.')
  return toPhotoRead(photoJson(content))
}

/** What the reader saw, as lines for the agent's user turn (data, never instructions). */
export function describePhoto(read: PhotoRead): string {
  if (read.kind === 'other') return `The photo is not a product packet${read.notes ? `: ${read.notes}` : ''}.`
  const fields: Array<[string, string | null]> = [
    ['Brand', read.brand],
    ['Product', read.product],
    ['Pack size', read.packSize],
    ['Batch code as read', read.batchNo ?? 'not visible'],
    ['Unsure characters', read.batchNoDoubts.length ? read.batchNoDoubts.join('; ') : null],
    ['MFG date', read.mfgDate],
    ['EXP date', read.expDate],
    ['Best before', read.bestBefore],
    ['MRP', read.mrp],
    ['Other print', read.notes],
  ]
  return [
    `A product packet (photo ${read.quality === 'clear' ? 'clear' : read.quality === 'partial' ? 'partly readable' : 'unreadable'}). Printed on it:`,
    ...fields.filter(([, value]) => value).map(([label, value]) => `- ${label}: ${value}`),
  ].join('\n')
}

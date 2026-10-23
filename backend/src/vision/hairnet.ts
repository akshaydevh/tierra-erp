import { z } from 'zod'
import { samplingParams } from '../agent/model-params'
import type { PhotoEnv } from '../agent/packet-reader'

/**
 * The computer-vision demo: one webcam frame, one vision call that says whether the person in it wears a hairnet
 * (food-safety hair restraint). It is the hairnet-check prototype's prompt and verdicts, so the two compare; the
 * factory-floor cameras will run the same check later. Nothing is stored: the frame is sent, judged and dropped.
 */

export const HAIRNET_TIMEOUT_MS = 45_000

export const HAIRNET_VERDICTS = ['wearing', 'not_wearing', 'uncertain', 'no_person'] as const
export type HairnetVerdict = (typeof HAIRNET_VERDICTS)[number]

export const HEADWEAR = ['hairnet', 'bouffant_cap', 'other_headwear', 'none', 'not_visible'] as const
export type Headwear = (typeof HEADWEAR)[number]

/** A box as fractions (0 to 1) of the frame's width and height, origin top-left. */
export type FrameBox = { x: number; y: number; width: number; height: number }

export type HairnetCheck = {
  /** wearing; not_wearing (head clearly visible, no hairnet); uncertain (can't confirm either way); no_person. */
  verdict: HairnetVerdict
  /** What is on the primary person's head. */
  headwear: Headwear
  /** When wearing: whether all the hair is contained. Null otherwise. */
  hairFullyCovered: boolean | null
  /** 0 to 1, the model's own sureness (not calibrated). */
  confidence: number
  /** One sentence a shift supervisor can read. */
  reason: string
  peopleCount: number
  headBox: FrameBox | null
}

export class HairnetCheckError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HairnetCheckError'
  }
}

const fraction = z.preprocess((value) => {
  const n = Number(value)
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0
}, z.number())

const boxSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })

const checkSchema = z.object({
  verdict: z.enum(HAIRNET_VERDICTS),
  headwear: z.preprocess((value) => ((HEADWEAR as readonly unknown[]).includes(value) ? value : 'not_visible'), z.enum(HEADWEAR)),
  hair_fully_covered: z.preprocess((value) => (typeof value === 'boolean' ? value : null), z.boolean().nullable()),
  confidence: fraction,
  reason: z.preprocess((value) => (value == null ? '' : String(value).trim().slice(0, 300)), z.string()),
  people_count: z.preprocess((value) => Math.max(0, Math.round(Number(value) || 0)), z.number()),
  head_box: z.preprocess((value) => (boxSchema.safeParse(value).success ? value : null), boxSchema.nullable()),
})

/** The box clipped to the frame; null when nothing of it is left. */
function clippedBox(box: FrameBox | null): FrameBox | null {
  if (!box) return null
  const x = Math.min(1, Math.max(0, box.x))
  const y = Math.min(1, Math.max(0, box.y))
  const width = Math.min(1 - x, Math.max(0, box.width))
  const height = Math.min(1 - y, Math.max(0, box.height))
  return width > 0 && height > 0 ? { x, y, width, height } : null
}

const CHECK_PROMPT = [
  'You check webcam frames for food-safety hair restraint compliance at Tierra Food India, a snack factory.',
  'Decide whether the person in the frame is wearing a hairnet.',
  '',
  'What counts as a hairnet: a mesh hairnet, or a disposable bouffant/mob-style hair cover, worn on the head over the hair.',
  'Baseball caps, beanies, hoods, headscarves, headbands, hair ties and clips do not count.',
  'A hairnet held in a hand, hanging around the neck, or lying nearby does not count.',
  '',
  'Hairnets are often thin, dark, or translucent mesh that is easy to miss on similar-coloured hair.',
  'Before concluding there is none, look at the hairline, crown, temples and around the ears for an elastic edge or mesh texture.',
  '',
  'Return only JSON with these keys:',
  '- verdict: "wearing" if a hairnet is on the head; "not_wearing" if the head and hair are clearly visible and there is no hairnet;',
  '"uncertain" if the head is cut off, turned away, too dark or blurry, or the mesh can\'t be confirmed either way;',
  '"no_person" if no human head is in the frame. With several people, judge everyone visible: "not_wearing" if anyone clearly lacks one.',
  '- headwear: what is on the primary person\'s head: "hairnet", "bouffant_cap", "other_headwear", "none" or "not_visible".',
  '- hair_fully_covered: when wearing, whether all the hair appears contained (false if a fringe, ponytail or strands visibly escape); null otherwise.',
  '- confidence: 0 to 1, how sure you are of the verdict.',
  '- reason: one short sentence a shift supervisor can read, saying what you saw.',
  '- people_count: how many people are visible.',
  '- head_box: {"x","y","width","height"} of the primary person\'s head as fractions of the image (x and width relative to image width,',
  'y and height relative to image height, each 0 to 1, origin top-left), or null if no head is visible.',
].join('\n')

export function toHairnetCheck(value: unknown): HairnetCheck {
  const parsed = checkSchema.safeParse(value)
  if (!parsed.success) throw new HairnetCheckError('The vision model gave an answer Tierra could not read.')
  const data = parsed.data
  return {
    verdict: data.verdict,
    headwear: data.headwear,
    hairFullyCovered: data.verdict === 'wearing' ? data.hair_fully_covered : null,
    confidence: data.confidence,
    reason: data.reason,
    peopleCount: data.people_count,
    headBox: clippedBox(data.head_box),
  }
}

/** Checks one JPEG frame. Throws HairnetCheckError; `signal` stops the call when the browser gives up on it. */
export async function checkHairnet(image: Buffer, env: PhotoEnv, signal?: AbortSignal): Promise<HairnetCheck> {
  if (!env.openaiApiKey) throw new HairnetCheckError('No OpenAI key is configured, so frames cannot be checked.')
  const timeout = AbortSignal.timeout(HAIRNET_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(`${env.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { authorization: `Bearer ${env.openaiApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.openaiVisionModel,
        ...samplingParams(env.openaiVisionModel, { temperature: 0, effort: env.openaiReasoningEffort, withTools: false }),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CHECK_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Is the person wearing a hairnet?' },
              // high: thin mesh is lost at low detail
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image.toString('base64')}`, detail: 'high' } },
            ],
          },
        ],
      }),
    })
  } catch {
    throw new HairnetCheckError(timeout.aborted ? 'The vision model took too long to answer.' : 'The vision model did not answer.')
  }
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300)
    console.error(`The hairnet check failed (${response.status}) ${detail}`)
    throw new HairnetCheckError(
      response.status === 429 ? 'The vision model is rate limited. Slow the live interval and try again.' : `The vision model failed (${response.status}).`,
    )
  }
  const payload = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string; refusal?: string } }> }
  const message = payload.choices?.[0]?.message
  if (message?.refusal) throw new HairnetCheckError('The vision model declined to assess this frame.')
  const content = message?.content?.trim()
  if (!content) throw new HairnetCheckError('The vision model gave no answer.')
  try {
    return toHairnetCheck(JSON.parse(content.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()))
  } catch (error) {
    if (error instanceof HairnetCheckError) throw error
    throw new HairnetCheckError('The vision model did not return JSON.')
  }
}

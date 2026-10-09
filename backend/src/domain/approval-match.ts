/**
 * What counts as the admin approving, sending back or stopping a sales order (plan §P4). Pure text rules; the
 * caller checks who is speaking (the admin, by exact phone or LID) and which approval is meant.
 *
 * 1. 👍 / ✅ / 👌 in any skin tone, as a reaction on a registered message of a pending, current-version approval.
 * 2. A quoted reply whose whole text is the approve lexicon (approve(d), ok(ay), yes, go ahead, send it), with no
 *    negation or doubt (not, don't, no, ?, hold, wait, later, change).
 * 3. Unquoted "approve", "approved" or "approve TSO/26-27/0001".
 * 4. Anything else, while exactly one approval is pending or pinned: a constrained model call (approval_intent).
 *    Its "approve" is only taken when rule 2's guard also passes.
 */

const SKIN_TONE_OR_VARIANT = /[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu
const APPROVE_EMOJI = new Set(['👍', '✅', '👌'])

export function isApproveEmoji(emoji: string | null | undefined): boolean {
  return APPROVE_EMOJI.has((emoji ?? '').replace(SKIN_TONE_OR_VARIANT, '').trim())
}

const WORD = '(?:approve|approved|ok|okay|yes|go ahead|send it)'
const LEXICON = new RegExp(`^${WORD}(?:[\\s,]+${WORD})*$`)
/** Doubt or negation anywhere in the message: never an approval. */
const DOUBT = /\?|\b(?:not|no|don'?t|do not|hold|wait|later|change|cancel|stop)\b|n't\b/i

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(SKIN_TONE_OR_VARIANT, '')
    .replace(/[👍✅👌]/gu, ' ')
    .replace(/[.!]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function hasDoubt(text: string): boolean {
  return DOUBT.test(text)
}

/** Rule 2: the whole text is approval words, or only an approve emoji, and nothing doubtful. */
export function isApproveReply(text: string): boolean {
  if (hasDoubt(text)) return false
  const words = normalise(text)
  if (!words) return /[👍✅👌]/u.test(text)
  return LEXICON.test(words)
}

const UNQUOTED = /^approved?(?:\s+(?:tso\s*)?(tso\/\d{2}-\d{2}\/\d{1,5}|\d{1,5}))?$/i

/** Rule 3: "approve", "approved", "approve TSO/26-27/0001" (or "approve 1"). Returns the number named, if any. */
export function unquotedApprove(text: string): { docNo: string | null } | null {
  const cleaned = text.trim().replace(/[.!]+$/g, '').replace(/\s+/g, ' ')
  const match = UNQUOTED.exec(cleaned)
  if (!match) return null
  return { docNo: match[1] ? match[1].toUpperCase() : null }
}

const SEND_BACK = /^send\s*(?:it\s*)?back\b\s*[:\-–—,]?\s*([\s\S]*)$/i

/** "send back: price is wrong on line 2" -> the note (possibly empty). Null when the text is not a send-back. */
export function sendBackNote(text: string): string | null {
  const match = SEND_BACK.exec(text.trim())
  return match ? match[1]!.trim() : null
}

export function isStop(text: string): boolean {
  return /^(?:stop|cancel|don'?t send)[.!]*$/i.test(text.trim())
}

/** Questions are answered, never classified: a "?" or a question word up front. */
export function looksLikeQuestion(text: string): boolean {
  return /\?/.test(text) || /^(?:what|why|when|where|which|who|how|is|are|can|could|does|do|did|will|should|tell|show|explain)\b/i.test(text.trim())
}

export type ApprovalIntent = 'approve' | 'send_back' | 'question' | 'other'

export const INTENT_PROMPT = [
  'You classify one WhatsApp message from the admin of Tierra Food India about a pending sales order.',
  'Answer only JSON: {"intent": "approve" | "send_back" | "question" | "other", "note": string | null}.',
  'approve: the admin clearly says yes to this sales order now. send_back: the admin wants it changed or rejected;',
  'put what to change in note. question: the admin asks something or wants something sent (a PDF, a figure).',
  'other: anything else. When unsure, answer question.',
].join(' ')

/** Reads the model's JSON; anything unreadable is a question (the safe default). */
export function parseIntent(content: string | null): { intent: ApprovalIntent; note: string | null } {
  if (!content) return { intent: 'question', note: null }
  const json = /\{[\s\S]*\}/.exec(content)?.[0]
  if (!json) return { intent: 'question', note: null }
  try {
    const value = JSON.parse(json) as { intent?: unknown; note?: unknown }
    const intent = ['approve', 'send_back', 'question', 'other'].includes(String(value.intent)) ? (value.intent as ApprovalIntent) : 'question'
    return { intent, note: typeof value.note === 'string' && value.note.trim() ? value.note.trim() : null }
  } catch {
    return { intent: 'question', note: null }
  }
}

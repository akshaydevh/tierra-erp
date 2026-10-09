import { dayLabel, defaultInputDate, istDay, namedDay } from '../domain/daily-report'
import type { Effect } from './tools'

/**
 * The prompt-injection guard on side effects (review S4). Text the model reads (tool results, a PDF, earlier turns)
 * can try to make it record stock or finish a task. Those two effects are only carried out when the message being
 * answered asks for it in its own words:
 * - complete_task: the message says done / complete / finish / close;
 * - record_receipt: the message says receive(d) / got / arrived, and names each line's item code or quantity.
 * - set_daily_inputs: every figure saved is written in the message (each manpower count, the weight in kg or tonnes),
 *   a yes / no names production, packing or cartoning, and the day is the one the message names (none named: the
 *   default, yesterday before noon India time and today after). A note is saved only when the message says
 *   "note:", and then it is the message's own text after it.
 * Anything else is dropped and the reply asks the person to say it themselves. create_task, send_so_pdf and
 * send_daily_report pass: they only add a task for a person to read, or send a PDF into the same chat.
 */

const DONE_WORDS = /\b(?:done|complete|completed|finish|finished|close|closed|mark(?:ed)?\s+(?:it\s+)?(?:as\s+)?done)\b/i
const RECEIVE_WORDS = /\b(?:receive|received|receiving|recd|rcvd|got|arrived|came in)\b/i

/** "1,500", "1500" and "1500.0" are the same quantity. */
function mentionsQuantity(text: string, qty: number): boolean {
  const numbers = [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((match) => Number(match[0].replace(/,/g, '')))
  return numbers.some((value) => Math.abs(value - qty) < 1e-9)
}

function dailyInputsNamed(patch: Extract<Effect, { kind: 'set_daily_inputs' }>['patch'], text: string): boolean {
  if (patch.manpower && !Object.values(patch.manpower).every((n) => n === 0 || mentionsQuantity(text, n))) return false
  for (const kg of [patch.bananaKgEstimate, patch.cassavaKgEstimate]) {
    if (kg != null && !mentionsQuantity(text, kg) && !mentionsQuantity(text, kg / 1000)) return false
  }
  if (patch.productionRun != null && !/\bproduc/i.test(text)) return false
  if (patch.packingRun != null && !/\bpack/i.test(text)) return false
  if (patch.cartoningRun != null && !/\bcarton/i.test(text)) return false
  return true
}

/** The text after "note:" / "notes:" in the message, or null. */
export function noteInMessage(text: string): string | null {
  const match = /\bnotes?\s*:\s*([\s\S]+)$/i.exec(text)
  const note = match?.[1]?.trim()
  return note ? note.slice(0, 500) : null
}

/** The day a message's daily inputs are for: the day it names, else the default for the time it was sent. */
export function inputsDayOf(text: string, now: Date): string {
  return namedDay(text, istDay(now)) ?? defaultInputDate(now)
}

export type GatedEffects = { allowed: Effect[]; refused: string[] }

export function gateEffects(effects: Effect[], text: string, now: Date = new Date()): GatedEffects {
  const allowed: Effect[] = []
  const refused: string[] = []
  for (const effect of effects) {
    if (effect.kind === 'complete_task') {
      if (DONE_WORDS.test(text)) allowed.push(effect)
      else refused.push(`I have not marked “${effect.title}” done. Say "done" (or reply *done* to its notice) to confirm.`)
      continue
    }
    if (effect.kind === 'record_receipt') {
      const named = effect.lines.filter(
        (line) => text.toUpperCase().includes(line.itemCode.toUpperCase()) || mentionsQuantity(text, line.qty),
      )
      const dropped = effect.lines.filter((line) => !named.includes(line))
      if (RECEIVE_WORDS.test(text) && named.length) {
        allowed.push({ ...effect, lines: named })
        if (dropped.length) refused.push(`I have not recorded ${dropped.map((line) => line.itemCode).join(', ')}: name each item and quantity in your message to confirm.`)
      } else {
        const what = effect.lines.map((line) => `${line.qty}${line.unit ? ` ${line.unit}` : ''} ${line.itemCode}`).join(', ')
        refused.push(`I have not recorded ${what} as received. To confirm, send it yourself, like "received ${what}".`)
      }
      continue
    }
    if (effect.kind === 'set_daily_inputs') {
      const day = inputsDayOf(text.replace(/\bnotes?\s*:[\s\S]*$/i, ''), now)
      const note = noteInMessage(text)
      const patch = { ...effect.patch }
      if (patch.notes !== undefined) {
        if (note) patch.notes = note
        else delete patch.notes
      }
      if (effect.date !== day) {
        refused.push(`I have not saved those daily report figures: they are for ${dayLabel(effect.date)}, but your message is for ${dayLabel(day)}. Send them again with the day, like *manpower 7 6 6 7 19 25 2 13 for 15/7*.`)
      } else if (!dailyInputsNamed(patch, text)) {
        refused.push('I have not saved those daily report figures. Send them yourself, like *manpower 7 6 6 7 19 25 2 13* or *banana 11t*.')
      } else if (Object.keys(patch).length === 0) {
        refused.push('I have not saved a note: write *note:* and the note after it.')
      } else {
        allowed.push({ ...effect, patch })
        if (effect.patch.notes !== undefined && !note) refused.push('I have not saved a note: write *note:* and the note after it.')
      }
      continue
    }
    allowed.push(effect)
  }
  return { allowed, refused }
}

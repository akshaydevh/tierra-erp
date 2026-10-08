const YES = new Set(['yes', 'y', 'confirm', 'confirmed', 'approve', 'approved', 'ok', 'okay'])
const NO = new Set(['no', 'n', 'cancel', 'decline', 'reject', 'rejected'])

export type ConfirmationChoice = {
  answer: 'yes' | 'no'
  /** "yes 5901346472" or "no PO 5901346472" names the order. */
  poNumber: string | null
}

function answerFor(word: string): 'yes' | 'no' | null {
  const value = word.toLowerCase()
  if (YES.has(value)) return 'yes'
  if (NO.has(value)) return 'no'
  return null
}

/** Undefined when the words after yes/no are not a PO number, so "yes please" is not a confirmation. */
function poNumberFrom(words: string[]): string | null | undefined {
  const [first, second, ...extra] = words
  if (!first) return null
  if (extra.length > 0) return undefined
  const named = second ? (/^po#?$/i.test(first) ? second : undefined) : first
  const poNumber = named?.replace(/^#/, '')
  return poNumber && /[\d/-]/.test(poNumber) ? poNumber : undefined
}

export function confirmationChoice(text: string): ConfirmationChoice | null {
  const [word = '', ...rest] = text.trim().replace(/[.!]+$/g, '').split(/\s+/)
  const answer = answerFor(word)
  const poNumber = poNumberFrom(rest)
  if (!answer || poNumber === undefined) return null
  return { answer, poNumber }
}

export function samePoNumber(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

export function adminOnlyReply(poNumber: string): string {
  return `Only an admin can confirm PO ${poNumber}. No order was created.`
}

export function declinedReply(poNumber: string): string {
  return `PO ${poNumber} was not confirmed. No order was created.`
}

export function whichPoReply(answer: 'yes' | 'no'): string {
  return `Which PO? Reply ${answer.toUpperCase()} <PO number>, or reply to its message.`
}

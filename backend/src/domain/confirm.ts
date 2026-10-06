const YES = new Set(['yes', 'y', 'confirm', 'confirmed', 'approve', 'approved', 'ok', 'okay'])
const NO = new Set(['no', 'n', 'cancel', 'decline', 'reject', 'rejected'])

export function confirmationChoice(text: string): 'yes' | 'no' | null {
  const value = text.trim().toLowerCase().replace(/[.!]+$/g, '')
  if (YES.has(value)) return 'yes'
  if (NO.has(value)) return 'no'
  return null
}

export function adminOnlyReply(poNumber: string): string {
  return `Only an admin can confirm PO ${poNumber}. No order was created.`
}

export function declinedReply(poNumber: string): string {
  return `PO ${poNumber} was not confirmed. No order was created.`
}

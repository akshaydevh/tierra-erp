import type { AccountLink, Role } from '../db/types'
import { phoneDigits } from './qr'
import type { ChatKind, IncomingMessage } from './parse'

export type Person = {
  name: string
  role: Role
  phoneNumber: string
}

type LinkedAccount = AccountLink & { phoneNumber: string }

export function phonesMatch(stored: string, candidate: string | null | undefined): boolean {
  const left = phoneDigits(stored)
  const right = phoneDigits(candidate)
  if (left.length < 8 || right.length < 8) return false
  if (left === right) return true
  const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left]
  return longer.endsWith(shorter) && longer.length - shorter.length <= 3 && shorter.length >= 10
}

function linkedAccounts(accounts: AccountLink[]): LinkedAccount[] {
  return accounts.filter((account): account is LinkedAccount => Boolean(account.phoneNumber))
}

function matchAccount(accounts: LinkedAccount[], candidates: Array<string | null | undefined>): LinkedAccount | null {
  for (const candidate of candidates) {
    if (!candidate) continue
    const found = accounts.find((account) => phonesMatch(account.phoneNumber, candidate))
    if (found) return found
  }
  return null
}

function toPerson(account: LinkedAccount): Person {
  return { name: account.name, role: account.role, phoneNumber: account.phoneNumber }
}

function numbersInText(text: string | null): string[] {
  return text?.match(/\d{8,15}/g) ?? []
}

export function resolvePeople(
  message: IncomingMessage,
  chatKind: ChatKind,
  accounts: AccountLink[],
  botPhone: string | null,
): { speaker: Person | null; mentioned: Person[] } {
  const linked = linkedAccounts(accounts)
  const speakerJids =
    chatKind === 'group'
      ? [message.participantJid, message.participantAltJid]
      : [message.remoteJid, message.aliasJid]
  const speakerAccount = matchAccount(linked, speakerJids)
  const speaker = speakerAccount ? toPerson(speakerAccount) : null

  const mentioned: Person[] = []
  const seen = new Set<string>()
  const candidates = [
    ...message.mentionedJids,
    ...numbersInText(message.text),
    ...numbersInText(message.quotedText),
  ]
  for (const candidate of candidates) {
    if (botPhone && phonesMatch(botPhone, candidate)) continue
    const account = matchAccount(linked, [candidate])
    if (!account || seen.has(account.id) || account.id === speakerAccount?.id) continue
    seen.add(account.id)
    mentioned.push(toPerson(account))
  }
  return { speaker, mentioned }
}

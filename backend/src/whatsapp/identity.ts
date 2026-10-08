import type { Store } from '../db/store'
import type { IncomingMessage } from './parse'
import { phoneDigits } from './qr'

type IdentityStore = Pick<Store, 'saveIdentity' | 'phoneForLid'>

function isLid(jid: string | null | undefined): jid is string {
  return Boolean(jid?.endsWith('@lid'))
}

function isPhoneJid(jid: string | null | undefined): jid is string {
  return Boolean(jid?.endsWith('@s.whatsapp.net') || jid?.endsWith('@c.us'))
}

export function lidKey(jid: string): string {
  return `${jid.replace(/@.*/, '').split(':')[0]}@lid`
}

function phoneJid(phone: string): string {
  return `${phone}@s.whatsapp.net`
}

function pairs(message: IncomingMessage): Array<[string | null, string | null]> {
  return [
    [message.participantJid, message.participantAltJid],
    [message.remoteJid, message.aliasJid],
  ]
}

/** Remembers every LID and phone number that arrive together on a message. */
export async function learnIdentities(store: IdentityStore, message: IncomingMessage): Promise<void> {
  for (const [first, second] of pairs(message)) {
    const lid = [first, second].find(isLid)
    const phone = phoneDigits([first, second].find(isPhoneJid))
    if (lid && phone.length >= 8) await store.saveIdentity(lidKey(lid), phone)
  }
}

async function phoneJidFor(store: IdentityStore, lid: string): Promise<string | null> {
  const phone = await store.phoneForLid(lidKey(lid))
  return phone ? phoneJid(phone) : null
}

/** Fills a missing phone JID next to a LID, and adds phone JIDs for mentioned LIDs, from what was learned before. */
export async function enrichIdentity(store: IdentityStore, message: IncomingMessage): Promise<IncomingMessage> {
  const enriched = { ...message, mentionedJids: [...message.mentionedJids] }
  if (isLid(message.participantJid) && !message.participantAltJid) {
    enriched.participantAltJid = await phoneJidFor(store, message.participantJid)
  }
  if (isLid(message.remoteJid) && !message.aliasJid) {
    enriched.aliasJid = await phoneJidFor(store, message.remoteJid)
  }
  for (const jid of message.mentionedJids.filter(isLid)) {
    const phone = await phoneJidFor(store, jid)
    if (phone && !enriched.mentionedJids.includes(phone)) enriched.mentionedJids.push(phone)
  }
  return enriched
}

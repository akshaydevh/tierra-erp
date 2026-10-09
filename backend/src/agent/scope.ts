import type { Store } from '../db/store'
import type { Role } from '../db/types'
import { cardCodesForParty } from '../queries/masters'
import { isNotImported } from '../queries/meta'
import type { CardScope, SapSql } from '../sap/db'
import type { Person } from '../whatsapp/people'
import { isGroupJid, type ChatKind } from '../whatsapp/parse'

/**
 * Who the bot is talking to, decided on the server from the chat and the sender, never by the model.
 * - internal: a linked Tierra account in a direct chat, the self chat or the desk. Every tool its role allows.
 * - party: a WhatsApp group mapped to a party group, even when Alex speaks there. Party-safe tools only, and every
 *   read is filtered to the party's SAP cards.
 * - public: an unmapped group or an unknown number. No data at all.
 */
export type Audience =
  | { kind: 'internal'; userId: string; name: string; role: Role }
  | {
      kind: 'party'
      partyGroupId: string
      name: string
      cardCodes: string[]
      pans: string[]
      groupSubject: string | null
      /** The linked account speaking in the group, if any; it changes nothing about the scope. */
      speakerName: string | null
    }
  | { kind: 'public'; reason: 'unmapped_group' | 'unknown_sender' }

/** The SAP cards an audience may read: all for internal, the party's cards, none for public. */
export function cardsFor(audience: Audience): CardScope {
  if (audience.kind === 'internal') return 'all'
  if (audience.kind === 'party') return audience.cardCodes
  return []
}

/** A party's cards: its card-code members plus every card whose bill-to GSTIN carries one of its PANs. */
export async function partyCardCodes(sql: SapSql, pans: string[], cardCodes: string[]): Promise<string[]> {
  try {
    const found = await cardCodesForParty(sql, { pans, cardCodes })
    return [...new Set([...found, ...cardCodes])].sort()
  } catch (error) {
    if (!isNotImported(error)) throw error
    return [...cardCodes].sort()
  }
}

export async function buildAudience(
  deps: { store: Store; sapSql: SapSql },
  input: { chatKind: ChatKind; remoteJid: string; speaker: Person | null },
): Promise<Audience> {
  if (input.chatKind === 'group' || isGroupJid(input.remoteJid)) {
    const group = await deps.store.getWaGroup(input.remoteJid)
    const party = group?.partyGroupId ? await deps.store.getPartyGroup(group.partyGroupId) : null
    if (!party) return { kind: 'public', reason: 'unmapped_group' }
    const pans = party.members.filter((member) => member.kind === 'pan').map((member) => member.value)
    const codes = party.members.filter((member) => member.kind === 'card_code').map((member) => member.value)
    return {
      kind: 'party',
      partyGroupId: party.id,
      name: party.alias || party.name,
      pans,
      cardCodes: await partyCardCodes(deps.sapSql, pans, codes),
      groupSubject: group?.subject ?? null,
      speakerName: input.speaker?.name ?? null,
    }
  }
  if (input.speaker) {
    return { kind: 'internal', userId: input.speaker.userId, name: input.speaker.name, role: input.speaker.role }
  }
  return { kind: 'public', reason: 'unknown_sender' }
}

import { describe, expect, it } from 'vitest'
import { enrichIdentity, learnIdentities } from './identity'
import { parseWebhook, type IncomingMessage } from './parse'

class FakeIdentities {
  rows = new Map<string, string>()

  async saveIdentity(lid: string, phone: string) {
    this.rows.set(lid, phone)
  }

  async phoneForLid(lid: string) {
    return this.rows.get(lid) ?? null
  }
}

const GROUP = '120363025246125486@g.us'
const JOSHY = '919812345678@s.whatsapp.net'
const JOSHY_LID = '187654321098765@lid'

function message(key: Record<string, unknown>, extra: Record<string, unknown> = {}): IncomingMessage {
  const event = parseWebhook({
    event: 'messages.upsert',
    instance: 'tierra',
    data: { key: { id: 'M1', fromMe: false, ...key }, message: { conversation: 'hi' }, ...extra },
  })
  if (event.type !== 'message') throw new Error('expected a message')
  return event.message
}

describe('learnIdentities', () => {
  it('learns the sender pair of a group message', async () => {
    const store = new FakeIdentities()
    await learnIdentities(store, message({ remoteJid: GROUP, participant: JOSHY_LID, participantAlt: JOSHY }))
    expect([...store.rows]).toEqual([[JOSHY_LID, '919812345678']])
  })

  it('learns the chat pair of a LID DM, whichever side is the LID', async () => {
    const store = new FakeIdentities()
    await learnIdentities(store, message({ remoteJid: JOSHY_LID, remoteJidAlt: JOSHY }))
    await learnIdentities(store, message({ remoteJid: '919900000002@s.whatsapp.net', remoteJidAlt: '2222@lid' }))
    expect(store.rows.get(JOSHY_LID)).toBe('919812345678')
    expect(store.rows.get('2222@lid')).toBe('919900000002')
  })

  it('drops the device suffix from a LID', async () => {
    const store = new FakeIdentities()
    await learnIdentities(store, message({ remoteJid: GROUP, participant: '187654321098765:12@lid', participantAlt: JOSHY }))
    expect(store.rows.get(JOSHY_LID)).toBe('919812345678')
  })

  it('learns nothing without a pair', async () => {
    const store = new FakeIdentities()
    await learnIdentities(store, message({ remoteJid: GROUP, participant: JOSHY_LID }))
    await learnIdentities(store, message({ remoteJid: JOSHY }))
    expect(store.rows.size).toBe(0)
  })
})

describe('enrichIdentity', () => {
  it('fills a missing participant phone from a learned pair', async () => {
    const store = new FakeIdentities()
    await learnIdentities(store, message({ remoteJid: GROUP, participant: JOSHY_LID, participantAlt: JOSHY }))
    const later = message({ remoteJid: GROUP, participant: JOSHY_LID })
    const enriched = await enrichIdentity(store, later)
    expect(enriched.participantAltJid).toBe(JOSHY)
    expect(later.participantAltJid).toBeNull()
  })

  it('fills a missing DM alias', async () => {
    const store = new FakeIdentities()
    await store.saveIdentity(JOSHY_LID, '919812345678')
    const enriched = await enrichIdentity(store, message({ remoteJid: JOSHY_LID }))
    expect(enriched.aliasJid).toBe(JOSHY)
  })

  it('keeps an alt JID that is already there', async () => {
    const store = new FakeIdentities()
    await store.saveIdentity(JOSHY_LID, '910000000000')
    const enriched = await enrichIdentity(store, message({ remoteJid: JOSHY_LID, remoteJidAlt: JOSHY }))
    expect(enriched.aliasJid).toBe(JOSHY)
  })

  it('adds phone JIDs for mentioned LIDs', async () => {
    const store = new FakeIdentities()
    await store.saveIdentity('555@lid', '919800000001')
    const mentioned = message(
      { remoteJid: GROUP, participant: JOSHY_LID },
      { message: { extendedTextMessage: { text: '@555 status?', contextInfo: { mentionedJid: ['555@lid'] } } } },
    )
    const enriched = await enrichIdentity(store, mentioned)
    expect(enriched.mentionedJids).toEqual(['555@lid', '919800000001@s.whatsapp.net'])
    expect(mentioned.mentionedJids).toEqual(['555@lid'])
  })

  it('leaves unknown LIDs alone', async () => {
    const enriched = await enrichIdentity(new FakeIdentities(), message({ remoteJid: GROUP, participant: JOSHY_LID }))
    expect(enriched.participantAltJid).toBeNull()
  })
})

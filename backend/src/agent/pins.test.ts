import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../db/memory'
import type { IncomingMessage } from '../whatsapp/parse'
import { chatJids, freshPin } from './pins'
import { recentTurns } from './route'
import type { AgentDeps } from './deps'

const PHONE = '919900000000@s.whatsapp.net'
const LID = '123456789@lid'
const now = new Date('2026-10-09T06:00:00.000Z')

function message(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: 'm2', remoteJid: LID, fromMe: false, text: 'and the cartons?', quotedText: null, quotedId: null, quotedParticipant: null,
    mentionedJids: [], participantJid: null, participantAltJid: null, aliasJid: PHONE, control: false, kind: 'text', reaction: null,
    pdf: null, raw: null, embeddedBase64: null, ...overrides,
  }
}

describe('chat pins across a chat’s jids', () => {
  it('reads every jid of the chat and takes the newest fresh pin, not the first one found', async () => {
    const store = new MemoryStore('hash')
    const deps = { store, now: () => now } as unknown as AgentDeps
    expect(chatJids(message())).toEqual([PHONE, LID])
    // the approval request pinned the phone jid an hour ago; the admin then quoted a PO message on the LID
    store.chatContexts.set(PHONE, { chatJid: PHONE, subjectType: 'approval', subjectId: 'apr_1', updatedAt: '2026-10-09T05:00:00.000Z' })
    store.chatContexts.set(LID, { chatJid: LID, subjectType: 'customer_po', subjectId: 'cpo_1', updatedAt: '2026-10-09T05:55:00.000Z' })
    expect(await freshPin(deps, message())).toMatchObject({ subjectType: 'customer_po', subjectId: 'cpo_1' })
    // the other way round
    store.chatContexts.set(PHONE, { chatJid: PHONE, subjectType: 'approval', subjectId: 'apr_2', updatedAt: '2026-10-09T05:58:00.000Z' })
    expect(await freshPin(deps, message())).toMatchObject({ subjectType: 'approval', subjectId: 'apr_2' })
    // older than 6 hours: no pin
    store.chatContexts.clear()
    store.chatContexts.set(PHONE, { chatJid: PHONE, subjectType: 'approval', subjectId: 'apr_3', updatedAt: '2026-10-08T23:59:00.000Z' })
    expect(await freshPin(deps, message())).toBeNull()
  })
})

describe('chat history for a turn', () => {
  it('stops at the message being answered: a later message of the chat never reaches an earlier turn', async () => {
    const store = new MemoryStore('hash')
    const deps = { store, now: () => now } as unknown as AgentDeps
    const add = (id: string, body: string, fromMe = false) => store.claimMessage({ evolutionMessageId: id, remoteJid: LID, fromMe, hasPdf: false, body })
    await add('m1', 'how much ZFGA100 is free?')
    await add('r1', '> 🧞‍♂️ Tierra Bot:\n\n300 free.', true)
    await add('m2', 'and the cartons?')
    await add('m3', 'cancel PO 4400012345')
    expect(await recentTurns(deps, message(), 'and the cartons?')).toEqual([
      { role: 'user', content: 'how much ZFGA100 is free?' },
      { role: 'assistant', content: '300 free.' },
    ])
    // the bot's reply to an earlier turn, sent after this message arrived, is still part of the conversation
    await add('r2', '> 🧞‍♂️ Tierra Bot:\n\nNoted.', true)
    expect((await recentTurns(deps, message(), 'and the cartons?')).map((turn) => turn.content)).toEqual(['how much ZFGA100 is free?', '300 free.', 'Noted.'])
  })
})

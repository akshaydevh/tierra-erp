import { describe, expect, it } from 'vitest'
import { TIERRA_HEADER, isBotEcho } from './brand'
import { audienceFor, parseWebhook, withoutMedia, type IncomingMessage } from './parse'

const BOT = '919800000001'
const BOT_JID = `${BOT}@s.whatsapp.net`
const JOSHY = '919812345678@s.whatsapp.net'
const JOSHY_LID = '187654321098765@lid'
const GROUP = '120363025246125486@g.us'

function upsert(data: Record<string, unknown>) {
  return {
    event: 'messages.upsert',
    instance: 'tierra',
    data: {
      pushName: 'Joshy',
      status: 'DELIVERY_ACK',
      messageTimestamp: 1_791_000_000,
      instanceId: '6a1b2c3d-0000-4000-8000-000000000000',
      source: 'android',
      ...data,
    },
    destination: 'http://api.railway.internal:3001/webhooks/evolution',
    date_time: '2026-10-08T10:15:00.000Z',
    sender: BOT_JID,
    server_url: 'http://evolution.railway.internal:8080',
    apikey: 'redacted',
  }
}

function parsed(data: Record<string, unknown>): IncomingMessage {
  const event = parseWebhook(upsert(data))
  if (event.type !== 'message') throw new Error(`expected a message, got ${event.type}`)
  return event.message
}

function reactionFrom(
  key: Record<string, unknown>,
  target: Record<string, unknown>,
  text: string,
): IncomingMessage {
  return parsed({
    key: { id: '3EB0REACT0001', ...key },
    message: {
      reactionMessage: { key: target, text, senderTimestampMs: '1791000000123' },
      messageContextInfo: { deviceListMetadataVersion: 2 },
    },
    messageType: 'reactionMessage',
  })
}

describe('parseWebhook reactions', () => {
  it('reads the target, emoji and target owner of a reaction', () => {
    const message = reactionFrom(
      { remoteJid: JOSHY, fromMe: false },
      { remoteJid: JOSHY, fromMe: true, id: '3EB0NOTICE0001' },
      '👍',
    )
    expect(message.kind).toBe('reaction')
    expect(message.control).toBe(false)
    expect(message.text).toBeNull()
    expect(message.reaction).toEqual({
      targetId: '3EB0NOTICE0001',
      emoji: '👍',
      targetFromMe: true,
      targetRemoteJid: JOSHY,
    })
  })

  it('reads a removed reaction as an empty emoji', () => {
    const message = reactionFrom(
      { remoteJid: JOSHY, fromMe: false },
      { remoteJid: JOSHY, fromMe: true, id: '3EB0NOTICE0001' },
      '',
    )
    expect(message.reaction?.emoji).toBe('')
  })

  it('reads a group reaction with a participant on the target key', () => {
    const message = reactionFrom(
      { remoteJid: GROUP, fromMe: false, participant: JOSHY_LID, participantAlt: JOSHY },
      { remoteJid: GROUP, fromMe: false, id: 'ABCDEF0123', participant: '123456789012345@lid' },
      '✅',
    )
    expect(message.participantJid).toBe(JOSHY_LID)
    expect(message.participantAltJid).toBe(JOSHY)
    expect(message.reaction).toEqual({
      targetId: 'ABCDEF0123',
      emoji: '✅',
      targetFromMe: false,
      targetRemoteJid: GROUP,
    })
  })

  it('leaves the target owner unknown when the key does not say', () => {
    const message = reactionFrom({ remoteJid: JOSHY, fromMe: false }, { id: 'older' }, '👍')
    expect(message.reaction).toEqual({ targetId: 'older', emoji: '👍', targetFromMe: null, targetRemoteJid: null })
  })

  it('still treats protocol messages and poll updates as control', () => {
    const revoke = parsed({
      key: { id: 'P1', remoteJid: JOSHY, fromMe: false },
      message: { protocolMessage: { key: { remoteJid: JOSHY, fromMe: false, id: 'X' }, type: 'REVOKE' } },
      messageType: 'protocolMessage',
    })
    const poll = parsed({
      key: { id: 'P2', remoteJid: JOSHY, fromMe: false },
      message: { pollUpdateMessage: { pollCreationMessageKey: { id: 'Y' } } },
    })
    expect(revoke.control).toBe(true)
    expect(revoke.reaction).toBeNull()
    expect(poll.control).toBe(true)
  })
})

describe('parseWebhook quotes', () => {
  const quoted = { conversation: `${TIERRA_HEADER}\n\nNew task for you: Order 2 t banana` }

  it('finds stanzaId on the container contextInfo (Evolution v2)', () => {
    const message = parsed({
      key: { id: 'Q1', remoteJid: JOSHY, fromMe: false },
      message: { conversation: 'done' },
      contextInfo: { stanzaId: '3EB0NOTICE0001', participant: BOT_JID, quotedMessage: quoted },
      messageType: 'conversation',
    })
    expect(message.quotedId).toBe('3EB0NOTICE0001')
    expect(message.quotedParticipant).toBe(BOT_JID)
    expect(message.quotedText).toContain('New task for you')
    expect(message.kind).toBe('text')
  })

  it('finds stanzaId on message.contextInfo', () => {
    const message = parsed({
      key: { id: 'Q2', remoteJid: JOSHY, fromMe: false },
      message: { conversation: 'done', contextInfo: { stanzaId: 'S2', participant: BOT_JID } },
    })
    expect(message.quotedId).toBe('S2')
  })

  it('finds stanzaId on extendedTextMessage', () => {
    const message = parsed({
      key: { id: 'Q3', remoteJid: JOSHY, fromMe: false },
      message: {
        extendedTextMessage: {
          text: 'completed',
          contextInfo: { stanzaId: 'S3', participant: BOT_JID, quotedMessage: quoted },
        },
      },
      messageType: 'extendedTextMessage',
    })
    expect(message.text).toBe('completed')
    expect(message.quotedId).toBe('S3')
    expect(message.quotedParticipant).toBe(BOT_JID)
  })

  it('finds stanzaId on a documentMessage', () => {
    const message = parsed({
      key: { id: 'Q4', remoteJid: JOSHY, fromMe: false },
      message: {
        documentMessage: {
          fileName: 'PO-4471.pdf',
          mimetype: 'application/pdf',
          contextInfo: { stanzaId: 'S4', participant: BOT_JID },
        },
      },
      messageType: 'documentMessage',
    })
    expect(message.quotedId).toBe('S4')
    expect(message.kind).toBe('document')
    expect(message.pdf).toEqual({ fileName: 'PO-4471.pdf', mimeType: 'application/pdf' })
  })

  it('finds stanzaId inside documentWithCaptionMessage', () => {
    const message = parsed({
      key: { id: 'Q5', remoteJid: JOSHY, fromMe: false },
      message: {
        documentWithCaptionMessage: {
          message: {
            documentMessage: {
              fileName: 'PO-4472.pdf',
              mimetype: 'application/pdf',
              caption: 'new PO',
              contextInfo: { stanzaId: 'S5', participant: BOT_JID },
            },
          },
        },
      },
      messageType: 'documentWithCaptionMessage',
    })
    expect(message.quotedId).toBe('S5')
    expect(message.text).toBe('new PO')
    expect(message.kind).toBe('document')
  })

  it('finds stanzaId on image and video messages', () => {
    const image = parsed({
      key: { id: 'Q6', remoteJid: JOSHY, fromMe: false },
      message: { imageMessage: { mimetype: 'image/jpeg', caption: 'photo', contextInfo: { stanzaId: 'S6' } } },
    })
    const video = parsed({
      key: { id: 'Q7', remoteJid: JOSHY, fromMe: false },
      message: { videoMessage: { mimetype: 'video/mp4', contextInfo: { stanzaId: 'S7' } } },
    })
    expect(image.quotedId).toBe('S6')
    expect(image.quotedParticipant).toBeNull()
    expect(image.kind).toBe('image')
    expect(video.quotedId).toBe('S7')
    expect(video.kind).toBe('other')
  })

  it('has no quote on a plain message', () => {
    const message = parsed({ key: { id: 'Q8', remoteJid: JOSHY, fromMe: false }, message: { conversation: 'hi' } })
    expect(message.quotedId).toBeNull()
    expect(message.quotedParticipant).toBeNull()
    expect(message.reaction).toBeNull()
  })

  it('reads mentions from the container contextInfo', () => {
    const message = parsed({
      key: { id: 'Q9', remoteJid: GROUP, fromMe: false, participant: JOSHY_LID, participantAlt: JOSHY },
      message: { conversation: '@919800000001 status?' },
      contextInfo: { mentionedJid: [BOT_JID] },
    })
    expect(message.mentionedJids).toEqual([BOT_JID])
  })

  it('reads LID DMs with remoteJidAlt', () => {
    const message = parsed({
      key: { id: 'Q10', remoteJid: JOSHY_LID, remoteJidAlt: JOSHY, fromMe: false, addressingMode: 'lid' },
      message: { conversation: 'hello' },
    })
    expect(message.remoteJid).toBe(JOSHY_LID)
    expect(message.aliasJid).toBe(JOSHY)
  })
})

describe('isBotEcho', () => {
  it('spots the bot header', () => {
    expect(isBotEcho(`${TIERRA_HEADER}\n\nDone.`)).toBe(true)
    expect(isBotEcho(`  ${TIERRA_HEADER} hi`)).toBe(true)
    expect(isBotEcho('Tierra Bot, status?')).toBe(false)
    expect(isBotEcho(null)).toBe(false)
  })
})

describe('audienceFor', () => {
  const text = (key: Record<string, unknown>, body: string, extra: Record<string, unknown> = {}) =>
    parsed({ key: { id: `T-${Math.random()}`, ...key }, message: { conversation: body }, ...extra })

  it('keeps personal mode behaviour by default', () => {
    expect(audienceFor(text({ remoteJid: JOSHY, fromMe: false }, 'hi'), BOT)).toBe('personal')
    expect(audienceFor(text({ remoteJid: BOT_JID, fromMe: true }, 'note to self'), BOT)).toBe('self')
    expect(audienceFor(text({ remoteJid: JOSHY, fromMe: true }, 'typed by owner'), BOT)).toBe('ignore')
  })

  it('drops the bot echo even in the self chat', () => {
    const echo = text({ remoteJid: BOT_JID, fromMe: true }, `${TIERRA_HEADER}\n\nTierra Bot is here.`)
    expect(audienceFor(echo, BOT)).toBe('ignore')
  })

  it('drops a fromMe group echo that names the bot', () => {
    const echo = text(
      { remoteJid: GROUP, fromMe: true, participant: '111@lid', participantAlt: BOT_JID },
      `${TIERRA_HEADER}\n\nTierra Bot has logged the PO.`,
    )
    expect(audienceFor(echo, BOT)).toBe('ignore')
  })

  it('does not treat a message from someone else that starts with the header as an echo', () => {
    const forwarded = text({ remoteJid: JOSHY, fromMe: false }, `${TIERRA_HEADER}\n\nforwarded`)
    expect(audienceFor(forwarded, BOT)).toBe('personal')
  })

  it('drops every fromMe message in dedicated mode', () => {
    const self = text({ remoteJid: BOT_JID, fromMe: true }, 'note to self')
    const outbound = text({ remoteJid: JOSHY, fromMe: true }, 'hello')
    expect(audienceFor(self, BOT, { botMode: 'dedicated' })).toBe('ignore')
    expect(audienceFor(outbound, BOT, { botMode: 'dedicated' })).toBe('ignore')
    expect(audienceFor(text({ remoteJid: JOSHY, fromMe: false }, 'hi'), BOT, { botMode: 'dedicated' })).toBe(
      'personal',
    )
  })

  it('drops the bot read receipt reaction', () => {
    const receipt = reactionFrom(
      { remoteJid: BOT_JID, fromMe: true },
      { remoteJid: BOT_JID, fromMe: true, id: 'M1' },
      '👀',
    )
    expect(audienceFor(receipt, BOT, { targetsBot: true })).toBe('ignore')
  })

  it('ignores reactions that do not target a bot message', () => {
    const reaction = reactionFrom({ remoteJid: JOSHY, fromMe: false }, { remoteJid: JOSHY, fromMe: false, id: 'X' }, '👍')
    expect(audienceFor(reaction, BOT)).toBe('ignore')
    expect(audienceFor(reaction, BOT, { targetsBot: false })).toBe('ignore')
  })

  it('routes reactions on bot messages to the chat they happen in', () => {
    const dm = reactionFrom({ remoteJid: JOSHY, fromMe: false }, { remoteJid: JOSHY, fromMe: true, id: 'N1' }, '👍')
    const group = reactionFrom(
      { remoteJid: GROUP, fromMe: false, participant: JOSHY_LID, participantAlt: JOSHY },
      { remoteJid: GROUP, fromMe: true, id: 'N2' },
      '👍',
    )
    const owner = reactionFrom({ remoteJid: BOT_JID, fromMe: true }, { remoteJid: BOT_JID, fromMe: true, id: 'N3' }, '👍')
    expect(audienceFor(dm, BOT, { targetsBot: true })).toBe('personal')
    expect(audienceFor(group, BOT, { targetsBot: true })).toBe('group')
    expect(audienceFor(owner, BOT, { targetsBot: true })).toBe('self')
    expect(audienceFor(owner, BOT, { targetsBot: true, botMode: 'dedicated' })).toBe('ignore')
  })

  it('handles a group reply to a bot message without a mention', () => {
    const reply = parsed({
      key: { id: 'G1', remoteJid: GROUP, fromMe: false, participant: JOSHY_LID, participantAlt: JOSHY },
      message: {
        extendedTextMessage: {
          text: 'done',
          contextInfo: {
            stanzaId: 'N4',
            participant: BOT_JID,
            quotedMessage: { conversation: `${TIERRA_HEADER}\n\nNew task` },
          },
        },
      },
    })
    expect(audienceFor(reply, BOT)).toBe('ignore')
    expect(audienceFor(reply, BOT, { targetsBot: true })).toBe('group')
  })

  it('still needs a mention for ordinary group messages', () => {
    const chatter = text({ remoteJid: GROUP, fromMe: false, participant: JOSHY_LID }, 'lunch?')
    const mention = text({ remoteJid: GROUP, fromMe: false, participant: JOSHY_LID }, 'Tierra Bot, status?')
    expect(audienceFor(chatter, BOT)).toBe('ignore')
    expect(audienceFor(mention, BOT)).toBe('group')
  })

  it('ignores control messages', () => {
    const revoke = parsed({
      key: { id: 'C1', remoteJid: JOSHY, fromMe: false },
      message: { protocolMessage: { type: 'REVOKE', key: { id: 'X' } } },
    })
    expect(audienceFor(revoke, BOT, { targetsBot: true })).toBe('ignore')
  })
})

describe('withoutMedia', () => {
  it('drops embedded file bytes and thumbnails but keeps what a download needs', () => {
    const message = parsed({
      key: { id: 'D9', remoteJid: JOSHY, fromMe: false },
      base64: 'JVBERi0xLjQ=',
      message: {
        base64: 'JVBERi0xLjQ=',
        documentMessage: {
          mimetype: 'application/pdf',
          fileName: 'po.pdf',
          mediaKey: 'key==',
          directPath: '/v/t62/abc',
          jpegThumbnail: '/9j/4AAQ',
        },
      },
    })
    expect(message.embeddedBase64).toBe('JVBERi0xLjQ=')
    const queued = withoutMedia(message)
    expect(queued.embeddedBase64).toBeNull()
    expect(queued.pdf).toEqual(message.pdf)
    expect(queued.raw).toMatchObject({
      key: { id: 'D9', remoteJid: JOSHY, fromMe: false },
      message: {
        documentMessage: { mimetype: 'application/pdf', fileName: 'po.pdf', mediaKey: 'key==', directPath: '/v/t62/abc' },
      },
    })
    expect(JSON.stringify(queued)).not.toContain('JVBER')
    expect(JSON.stringify(queued)).not.toContain('jpegThumbnail')
  })
})

import { safeEqual } from '../auth/cookie'
import type { AgentDeps } from '../agent/handle-message'
import { CONFIDENCE_FLOOR } from '../agent/classifiers'
import { incomingJob } from '../jobs/worker'
import { requeueTaskNotices } from '../tasks/notify'
import { isBotEcho } from './brand'
import { enrichIdentity, learnIdentities, learnParticipants, unmappedMentions } from './identity'
import {
  audienceFor,
  isGroupJid,
  isPersonalJid,
  parseWebhook,
  withoutMedia,
  type AudienceOptions,
  type IncomingMessage,
} from './parse'
import { normalizeQr } from './qr'

async function audienceOptions(deps: AgentDeps, message: IncomingMessage): Promise<AudienceOptions> {
  const targetId = message.reaction?.targetId ?? message.quotedId
  const target = targetId ? await deps.store.findMessage(targetId) : null
  return { targetsBot: Boolean(target?.fromMe && target.purpose), botMode: deps.botMode }
}

/**
 * A PDF posted in a WhatsApp group mapped to a customer goes to PO intake without a mention (plan §P3): the
 * customer drops its PO in the group. Questions there still need a mention. The bot's own messages never count.
 */
async function isMappedGroupPdf(deps: AgentDeps, message: IncomingMessage): Promise<boolean> {
  if (!message.pdf || message.fromMe || message.control || message.reaction || !isGroupJid(message.remoteJid)) return false
  return Boolean((await deps.store.getWaGroup(message.remoteJid))?.partyGroupId)
}

/**
 * WhatsApp sends a group @mention as the member's LID. The first time the bot's own LID (or anyone's) shows up
 * unmapped, learn the group's members from Evolution so the mention resolves to a phone.
 */
async function withGroupMembers(deps: AgentDeps, message: IncomingMessage): Promise<IncomingMessage | null> {
  if (!isGroupJid(message.remoteJid) || (await unmappedMentions(deps.store, message)).length === 0) return null
  const participants = await deps.evolution.fetchGroupParticipants(message.remoteJid).catch((error: unknown) => {
    console.error('Could not fetch WhatsApp group members', error)
    return []
  })
  if (participants.length === 0) return null
  await learnParticipants(deps.store, participants)
  return enrichIdentity(deps.store, message)
}

const NAMES_TIERRA = /\btierra\b/i

/**
 * A group message that names Tierra without a clear call ("Tierra Bot", "hey Tierra", an @mention): TypeSafe decides
 * whether it speaks to the bot. Without a key, on a failure or when unsure it does not.
 */
async function calledByName(deps: AgentDeps, message: IncomingMessage): Promise<boolean> {
  const text = message.text ?? ''
  if (!deps.callClassifier || !isGroupJid(message.remoteJid) || !NAMES_TIERRA.test(text)) return false
  if (message.control || message.reaction || isBotEcho(text) || (message.fromMe && deps.botMode === 'dedicated')) return false
  try {
    const group = (await deps.store.getWaGroup(message.remoteJid))?.subject ?? null
    const answer = await deps.callClassifier({ text, group })
    return answer.choice === 'call' && answer.confidence >= CONFIDENCE_FLOOR
  } catch (error) {
    console.error('call_intent (TypeSafe) failed; treating the message as chatter', error)
    return false
  }
}

function senderJid(message: IncomingMessage): string | null {
  if (message.participantJid) return message.participantAltJid ?? message.participantJid
  return message.fromMe ? null : (message.aliasJid ?? message.remoteJid)
}

export async function acceptWebhook(
  deps: AgentDeps & { webhookSecret: string },
  rawBody: string,
  secretHeader: string | undefined,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!safeEqual(secretHeader, deps.webhookSecret)) {
    return { status: 401, body: { error: 'Unauthorized' } }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody) as unknown
  } catch {
    return { status: 400, body: { error: 'Invalid JSON' } }
  }
  const event = parseWebhook(parsed)
  if (event.type === 'qr') {
    await deps.store.saveWhatsapp({
      status: 'qr_pending',
      qrBase64: normalizeQr(event.qr),
    })
    return { status: 200, body: { ok: true } }
  }
  if (event.type === 'connection') {
    const current = await deps.store.getWhatsapp()
    if (event.state === 'open') {
      const discovered = event.phone ?? (await deps.evolution.fetchOwnerPhone())
      await deps.store.saveWhatsapp({
        status: 'connected',
        qrBase64: null,
        phoneNumber: discovered ?? current.phoneNumber,
      })
      deps.evolution
        .ensureWebhook()
        .catch((error: unknown) => console.error('Could not update the WhatsApp webhook after pairing', error))
      await requeueTaskNotices(deps)
    } else if (event.state === 'connecting') {
      await deps.store.saveWhatsapp({ status: 'qr_pending' })
    } else {
      await deps.store.saveWhatsapp({ status: 'disconnected', qrBase64: null })
    }
    return { status: 200, body: { ok: true } }
  }
  if (event.type !== 'message') return { status: 200, body: { ok: true } }

  await learnIdentities(deps.store, event.message)
  let message = await enrichIdentity(deps.store, event.message)
  const options = await audienceOptions(deps, message)
  let connection = await deps.store.getWhatsapp()
  let audience = audienceFor(message, connection.phoneNumber, options)
  if (
    audience === 'ignore' &&
    message.fromMe &&
    deps.botMode === 'personal' &&
    !message.reaction &&
    !isBotEcho(message.text) &&
    (isPersonalJid(message.remoteJid) || (message.aliasJid ? isPersonalJid(message.aliasJid) : false))
  ) {
    const owner = await deps.evolution.fetchOwnerPhone()
    if (owner && owner !== connection.phoneNumber) {
      connection = await deps.store.saveWhatsapp({ phoneNumber: owner })
      audience = audienceFor(message, connection.phoneNumber, options)
    }
  }
  if (audience === 'ignore') {
    const resolved = await withGroupMembers(deps, event.message)
    if (resolved) {
      message = resolved
      audience = audienceFor(message, connection.phoneNumber, options)
    }
  }
  if (audience === 'ignore' && (await isMappedGroupPdf(deps, message))) audience = 'group'
  if (audience === 'ignore' && (await calledByName(deps, message))) audience = 'group'
  if (audience === 'ignore') return { status: 200, body: { ignored: true } }
  if (await deps.store.findMessage(message.id)) return { status: 200, body: { duplicate: true } }
  const queued = await deps.enqueue(incomingJob(withoutMedia(message), audience))
  if (!queued) return { status: 200, body: { duplicate: true } }
  await deps.store.claimMessage({
    evolutionMessageId: message.id,
    remoteJid: message.remoteJid,
    fromMe: message.fromMe,
    hasPdf: Boolean(message.pdf),
    body: message.text,
    senderJid: senderJid(message),
    quotedId: message.reaction?.targetId ?? message.quotedId,
    kind: message.kind,
    status: 'received',
  })
  return { status: 200, body: { ok: true } }
}

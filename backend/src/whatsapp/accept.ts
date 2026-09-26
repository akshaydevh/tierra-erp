import { safeEqual } from '../auth/cookie'
import { processPersonalPdf, type AgentDeps } from '../agent/handle-message'
import { isPersonalJid, parseWebhook } from './parse'
import { normalizeQr } from './qr'

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
      await deps.store.saveWhatsapp({
        status: 'connected',
        qrBase64: null,
        phoneNumber: event.phone ?? current.phoneNumber,
      })
    } else if (event.state === 'connecting') {
      await deps.store.saveWhatsapp({ status: 'qr_pending' })
    } else {
      await deps.store.saveWhatsapp({ status: 'disconnected', qrBase64: null })
    }
    return { status: 200, body: { ok: true } }
  }
  if (event.type !== 'message') return { status: 200, body: { ok: true } }

  const message = event.message
  if (message.fromMe || !isPersonalJid(message.remoteJid)) {
    return { status: 200, body: { ignored: true } }
  }
  const claimed = await deps.store.claimMessage({
    evolutionMessageId: message.id,
    remoteJid: message.remoteJid,
    fromMe: false,
    hasPdf: Boolean(message.pdf),
    body: message.text,
  })
  if (!claimed) return { status: 200, body: { duplicate: true } }
  if (!message.pdf) return { status: 200, body: { stored: true } }

  try {
    await processPersonalPdf(deps, message)
    return { status: 200, body: { ok: true } }
  } catch (error) {
    await deps.store.releaseMessage(message.id)
    throw error
  }
}

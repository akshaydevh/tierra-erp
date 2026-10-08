import { ownerPhoneFromInstances, qrFromPayload } from './qr'

export const INSTANCE_NAME = 'tierra'

export type DownloadedMedia = {
  base64: string
  mimeType: string
  fileName: string
}

export type SentText = {
  messageId: string | null
}

export type MediaMessage = {
  number: string
  mediatype: 'document' | 'image'
  mimetype: string
  fileName: string
  caption?: string
  /** Raw base64 (a data: prefix is stripped) or an https URL. */
  media: string
}

export type WhatsappGroup = {
  id: string
  subject: string
  size: number
}

export interface EvolutionClient {
  createInstance(): Promise<{ qrBase64: string | null }>
  deleteInstance(): Promise<void>
  sendText(number: string, text: string, mentionPhones?: string[]): Promise<SentText>
  sendReaction(remoteJid: string, messageId: string, fromMe: boolean, emoji: string): Promise<void>
  sendMedia(media: MediaMessage): Promise<SentText>
  downloadMedia(message: unknown): Promise<DownloadedMedia>
  fetchOwnerPhone(): Promise<string | null>
  fetchAllGroups(): Promise<WhatsappGroup[]>
  /** Points the existing instance's webhook at this backend. */
  ensureWebhook(): Promise<void>
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function messageIdFrom(value: unknown): string | null {
  const root = record(value)
  if (!root) return null
  const key = record(root.key)
  const direct = typeof key?.id === 'string' && key.id.length > 0 ? key.id : null
  if (direct) return direct
  const data = record(root.data)
  const nested = data ? record(data.key) : null
  if (typeof nested?.id === 'string' && nested.id.length > 0) return nested.id
  return typeof root.id === 'string' && root.id.length > 0 ? root.id : null
}

function mediaPayload(media: string): string {
  return media.replace(/^data:[^,]*;base64,/, '')
}

function groupRows(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const root = record(value)
  if (!root) return []
  for (const key of ['groups', 'data', 'response']) {
    if (Array.isArray(root[key])) return root[key]
  }
  return []
}

function groupSize(row: Record<string, unknown>): number {
  for (const key of ['size', 'participantsCount', 'participantCount']) {
    const value = row[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return Array.isArray(row.participants) ? row.participants.length : 0
}

export function groupsFrom(value: unknown): WhatsappGroup[] {
  return groupRows(value).flatMap((item) => {
    const row = record(item)
    const id = [row?.id, row?.jid, row?.remoteJid].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.endsWith('@g.us'),
    )
    if (!row || !id) return []
    const subject = [row.subject, row.name].find(
      (candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0,
    )
    return [{ id, subject: subject ?? id, size: groupSize(row) }]
  })
}

type EvolutionEnv = {
  evolutionUrl: string
  evolutionApiKey: string
  webhookUrl: string
  webhookSecret: string
}

export class HttpEvolution implements EvolutionClient {
  constructor(private readonly env: EvolutionEnv) {}

  private webhookBody() {
    const base = this.env.webhookUrl.replace(/\/$/, '')
    return {
      enabled: true,
      url: `${base}/webhooks/evolution`,
      byEvents: false,
      base64: false,
      events: ['QRCODE_UPDATED', 'CONNECTION_UPDATE', 'MESSAGES_UPSERT'],
      headers: { 'x-webhook-secret': this.env.webhookSecret },
    }
  }

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${this.env.evolutionUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers: {
        apikey: this.env.evolutionApiKey,
        'content-type': 'application/json',
        ...(init?.headers ?? {}),
      },
    })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`Evolution ${path} failed (${response.status})`)
    }
    return text ? (JSON.parse(text) as unknown) : {}
  }

  async deleteInstance(): Promise<void> {
    const response = await fetch(
      `${this.env.evolutionUrl.replace(/\/$/, '')}/instance/delete/${INSTANCE_NAME}`,
      { method: 'DELETE', headers: { apikey: this.env.evolutionApiKey } },
    )
    if (response.status === 404) return
    if (!response.ok) throw new Error(`Evolution delete failed (${response.status})`)
  }

  async createInstance(): Promise<{ qrBase64: string | null }> {
    await this.deleteInstance().catch(() => undefined)
    const created = await this.request('/instance/create', {
      method: 'POST',
      body: JSON.stringify({
        instanceName: INSTANCE_NAME,
        integration: 'WHATSAPP-BAILEYS',
        qrcode: true,
        syncFullHistory: false,
        webhook: this.webhookBody(),
      }),
    })
    await this.ensureWebhook()
    return { qrBase64: qrFromPayload(created) }
  }

  async ensureWebhook(): Promise<void> {
    await this.request(`/webhook/set/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify({ webhook: this.webhookBody() }),
    })
  }

  async sendText(number: string, text: string, mentionPhones: string[] = []): Promise<SentText> {
    const mentioned = mentionPhones.filter((phone) => phone.length > 0).map((phone) => `${phone}@s.whatsapp.net`)
    const data = await this.request(`/message/sendText/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify(mentioned.length > 0 ? { number, text, mentioned } : { number, text }),
    })
    return { messageId: messageIdFrom(data) }
  }

  async sendReaction(remoteJid: string, messageId: string, fromMe: boolean, emoji: string): Promise<void> {
    await this.request(`/message/sendReaction/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify({
        key: { remoteJid, fromMe, id: messageId },
        reaction: emoji,
      }),
    })
  }

  async sendMedia(media: MediaMessage): Promise<SentText> {
    const data = await this.request(`/message/sendMedia/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify({
        number: media.number,
        mediatype: media.mediatype,
        mimetype: media.mimetype,
        fileName: media.fileName,
        caption: media.caption,
        media: mediaPayload(media.media),
      }),
    })
    return { messageId: messageIdFrom(data) }
  }

  async fetchAllGroups(): Promise<WhatsappGroup[]> {
    const data = await this.request(`/group/fetchAllGroups/${INSTANCE_NAME}?getParticipants=false`)
    return groupsFrom(data)
  }

  async fetchOwnerPhone(): Promise<string | null> {
    try {
      const data = await this.request('/instance/fetchInstances')
      return ownerPhoneFromInstances(data)
    } catch {
      return null
    }
  }

  async downloadMedia(message: unknown): Promise<DownloadedMedia> {
    const data = (await this.request(`/chat/getBase64FromMediaMessage/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify({ message, convertToMp4: false }),
    })) as Record<string, unknown>
    const base64 = typeof data.base64 === 'string' ? data.base64 : ''
    if (!base64) throw new Error('Evolution did not return media')
    const mimeType = typeof data.mimetype === 'string' ? data.mimetype : 'application/pdf'
    const fileName = typeof data.fileName === 'string' ? data.fileName : 'purchase-order.pdf'
    return { base64, mimeType, fileName }
  }
}

import { qrFromPayload } from './qr'

export const INSTANCE_NAME = 'tierra'

export type DownloadedMedia = {
  base64: string
  mimeType: string
  fileName: string
}

export interface EvolutionClient {
  createInstance(): Promise<{ qrBase64: string | null }>
  deleteInstance(): Promise<void>
  sendText(number: string, text: string): Promise<void>
  downloadMedia(message: unknown): Promise<DownloadedMedia>
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
      base64: true,
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
    await this.request(`/webhook/set/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify({ webhook: this.webhookBody() }),
    })
    return { qrBase64: qrFromPayload(created) }
  }

  async sendText(number: string, text: string): Promise<void> {
    await this.request(`/message/sendText/${INSTANCE_NAME}`, {
      method: 'POST',
      body: JSON.stringify({ number, text }),
    })
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

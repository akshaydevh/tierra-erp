import type { DashboardSnapshot } from '../domain/reads'
import type { ExtractEnv } from './extract'

export type ChatInput = {
  text: string
  quotedText: string | null
  snapshot: DashboardSnapshot | null
}

export const CANNOT_REPLY = 'Tierra Bot cannot reply right now.'

const SYSTEM = [
  'You are Tierra Bot, the order-desk agent for Tierra Food India.',
  'Write a short WhatsApp reply.',
  'When a dashboard snapshot is provided, answer only from that JSON and do not invent figures.',
  'Modules listed in emptyModules have no records.',
  'When no snapshot is provided, do not recite orders, stock, customers, or other internal figures.',
].join(' ')

export function createCompleteChat(env: ExtractEnv): (input: ChatInput) => Promise<string> {
  return async (input) => {
    if (!env.poExtractApiKey) return CANNOT_REPLY
    const user = [
      input.text,
      input.quotedText ? `Quoted message:\n${input.quotedText}` : null,
      input.snapshot ? `Dashboard snapshot:\n${JSON.stringify(input.snapshot)}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')
    try {
      const response = await fetch(`${env.poExtractBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.poExtractApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.poExtractModel,
          temperature: 0.2,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: user },
          ],
        }),
      })
      if (!response.ok) return CANNOT_REPLY
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>
      }
      const content = payload.choices?.[0]?.message?.content?.trim()
      return content || CANNOT_REPLY
    } catch {
      return CANNOT_REPLY
    }
  }
}

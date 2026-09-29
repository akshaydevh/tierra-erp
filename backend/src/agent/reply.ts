import type { DashboardSnapshot } from '../domain/reads'
import type { ExtractEnv } from './extract'

export type ChatInput = {
  text: string
  quotedText: string | null
  snapshot: DashboardSnapshot | null
  unsure?: boolean
}

export const CANNOT_REPLY = 'Tierra Bot cannot reply right now.'
export const GREETING =
  'Hi, I am Tierra Bot, your assistant for Tierra. What would you like to know? I can give you a brief on what is going on in the factory.'

const SYSTEM = [
  'You are Tierra Bot, a personal assistant created to manage Tierra Food India through the company dashboard.',
  'You help with orders, stock, customers, and what is going on in the factory.',
  'Write a short, natural WhatsApp reply.',
  'When the message is a greeting or the request is unclear, greet the person, ask what they wish to know, and offer a brief on what is going on in the factory.',
  'When a dashboard snapshot is provided, answer only from that JSON and do not invent figures.',
  'Modules listed in emptyModules have no records.',
  'When no snapshot is provided, do not recite orders, stock, customers, or other internal figures.',
].join(' ')

export function createCompleteChat(env: ExtractEnv): (input: ChatInput) => Promise<string> {
  return async (input) => {
    if (!env.openaiApiKey) return input.unsure ? GREETING : CANNOT_REPLY
    const user = [
      input.text,
      input.quotedText ? `Quoted message:\n${input.quotedText}` : null,
      input.unsure
        ? 'The request is unclear. Greet them, ask what they wish to know, and offer a brief on what is going on in the factory.'
        : null,
      input.snapshot ? `Dashboard snapshot:\n${JSON.stringify(input.snapshot)}` : null,
    ]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')
    try {
      const response = await fetch(`${env.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.openaiApiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: env.openaiModel,
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

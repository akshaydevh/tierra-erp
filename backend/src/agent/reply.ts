import type { DashboardSnapshot } from '../domain/reads'
import type { ExtractEnv } from './extract'

export type ChatTurn = {
  speaker: 'owner' | 'contact' | 'tierra'
  text: string
}

export type ChatInput = {
  text: string
  quotedText: string | null
  snapshot: DashboardSnapshot | null
  history: ChatTurn[]
  unsure?: boolean
}

export const CANNOT_REPLY = 'Tierra Bot cannot reply right now.'
export const GREETING =
  'Hi, I am Tierra Bot, your assistant for Tierra. What would you like to know? I can give you a brief on what is going on in the factory.'

const SYSTEM = [
  'You are Tierra Bot, a personal assistant created to manage Tierra Food India through the company dashboard.',
  'You can answer any operations question from the dashboard snapshot: command centre, customers, orders and their lines, and inventory on hand, reserved, and available.',
  'That snapshot is the full set of live records. Modules listed in emptyModules have no data, so say they have no records and do not invent figures.',
  'Write a short, natural WhatsApp reply.',
  'When they ask what is going on, ask for a brief, or agree to a brief you already offered, summarize open orders, short stock, and the recent orders from the snapshot.',
  'When the message is only a greeting and they have not asked for a brief, greet them and offer one. Do not greet again instead of answering.',
  'When no snapshot is provided, do not recite orders, stock, customers, or other internal figures.',
].join(' ')

export function createCompleteChat(env: ExtractEnv): (input: ChatInput) => Promise<string> {
  return async (input) => {
    if (!env.openaiApiKey) return input.unsure ? GREETING : CANNOT_REPLY
    const history =
      input.history.length > 0
        ? `Recent chat:\n${input.history.map((turn) => `${turn.speaker}: ${turn.text}`).join('\n')}`
        : null
    const user = [
      history,
      `Latest message:\n${input.text}`,
      input.quotedText ? `Quoted message:\n${input.quotedText}` : null,
      input.unsure
        ? 'If they only greeted you, greet them and offer a factory brief. If they are asking about operations or agreeing to a brief, answer from the dashboard snapshot.'
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

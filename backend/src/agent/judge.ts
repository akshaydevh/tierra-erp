import { TypeSafeClient, choice } from '@typesafe-ai/sdk'
import type { Person } from '../whatsapp/people'
import type { ChatKind } from '../whatsapp/parse'
import { TYPESAFE_TIMEOUT_MS, withTimeout } from './timeout'

export type Intent = 'dashboard_question' | 'conversation' | 'needs_pdf' | 'create_task' | 'ignore'

export type JudgeInput = {
  chatKind: ChatKind
  text: string
  quotedText: string | null
  speaker: Person | null
  mentioned: Person[]
}

export type JudgeResult = {
  intent: Intent | 'unconfigured'
  confidence: number
}

export type Judge = (input: JudgeInput) => Promise<JudgeResult>

const INTENT_CRITERIA = {
  dashboard_question: 'The sender is asking about orders, stock, customers, tasks, or the command centre.',
  conversation: 'A normal reply is enough and no records are required.',
  needs_pdf: 'They want an order created or checked, and this message has no purchase-order PDF.',
  create_task: 'They want a task added to the board, or a person assigned to a new task.',
  ignore: 'There is nothing for Tierra Bot to do.',
} as const

export function createJudge(env: { typesafeApiKey: string }): Judge {
  return async (input) => {
    if (!env.typesafeApiKey) return { intent: 'unconfigured', confidence: 1 }
    const client = new TypeSafeClient({ apiKey: env.typesafeApiKey })
    const response = await withTimeout(
      client.systemOne({
        state: {
          chat: input.chatKind,
          text: input.text,
          quotedText: input.quotedText,
          speaker: input.speaker,
          mentioned: input.mentioned,
        },
        questions: {
          intent: choice(
            'What should Tierra Bot do with this WhatsApp message? The speaker and mentioned fields name Tierra accounts when a phone number is linked; use that identity as context. dashboard_question means the sender is asking about orders, stock, customers, tasks, or the command centre. conversation means a normal reply that does not need records. needs_pdf means they want an order created or checked but this message has no purchase-order PDF. create_task means they want a task added to the board or assigned to someone. ignore means there is nothing to do.',
            INTENT_CRITERIA,
          ),
        },
      }),
      TYPESAFE_TIMEOUT_MS,
      'The intent judge',
    )
    return {
      intent: response.answers.intent.choice,
      confidence: response.answers.intent.confidence,
    }
  }
}

import { TypeSafeClient, choice } from '@typesafe-ai/sdk'
import type { ApprovalIntent } from '../domain/approval-match'

export type ApprovalIntentInput = {
  /** "TSO/26-27/0001 (Reliance, ₹83,746.66)" */
  order: string
  text: string
}

export type ApprovalIntentResult = { intent: ApprovalIntent; confidence: number }

export type ApprovalIntentClassifier = (input: ApprovalIntentInput) => Promise<ApprovalIntentResult>

const INTENT_CRITERIA = {
  approve: 'The admin clearly says yes to this sales order now, so it can be sent to the customer.',
  send_back: 'The admin wants the sales order changed, corrected or rejected before it goes out.',
  question: 'The admin asks something, or wants something sent to them (a PDF, a figure, an explanation).',
  other: 'The message is about something else, or it is not clear what the admin wants for this order.',
} as const

const TIMEOUT_MS = 30_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TypeSafe did not answer within ${ms / 1000} s`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** TypeSafe's choice of what an admin message means for a pending sales order. Null without a key. */
export function createApprovalIntent(env: { typesafeApiKey: string }): ApprovalIntentClassifier | null {
  if (!env.typesafeApiKey) return null
  const client = new TypeSafeClient({ apiKey: env.typesafeApiKey })
  return async (input) => {
    const response = await withTimeout(
      client.systemOne({
        state: { pendingSalesOrder: input.order, adminMessage: input.text },
        questions: {
          intent: choice(
            'A sales order is waiting for the admin of Tierra Food India to approve it. What does this WhatsApp message from the admin mean for that order? Choose question or other when unsure.',
            INTENT_CRITERIA,
          ),
        },
      }),
      TIMEOUT_MS,
    )
    return { intent: response.answers.intent.choice, confidence: response.answers.intent.confidence }
  }
}

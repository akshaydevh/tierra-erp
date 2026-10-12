import { TypeSafeClient, choice } from '@typesafe-ai/sdk'
import { withTimeout } from './approval-intent'

/**
 * TypeSafe's cheap one-of-N calls outside SO approvals: is a group message a call to the bot, is a PDF a customer PO,
 * does the admin's reply say to proceed with a PO.
 * Each returns null without TYPESAFE_API_KEY; callers fall back to their rules then, and on a failure or low confidence.
 */

export type Classified<T extends string> = { choice: T; confidence: number }

export type CallIntent = 'call' | 'chatter'
export type CallClassifier = (input: { text: string; group: string | null }) => Promise<Classified<CallIntent>>

export type PdfKind = 'customer_po' | 'tierra_document' | 'other'
export type PdfClassifier = (input: { text: string }) => Promise<Classified<PdfKind>>

export type ProceedIntent = 'proceed' | 'hold' | 'question' | 'other'
export type ProceedClassifier = (input: { po: string; text: string }) => Promise<Classified<ProceedIntent>>

/** Below this a classifier's answer is not trusted and the rules decide. */
export const CONFIDENCE_FLOOR = 0.6

/** Kept short: these sit on the webhook path (a call) or before the PO reader. */
const TIMEOUT_MS = 10_000
/** Page 1 carries the header that says what a document is. */
const PDF_TEXT_CHARS = 4000

const CALL_CRITERIA = {
  call: 'The message speaks to Tierra Bot, the WhatsApp assistant, by the name Tierra: asks it something, greets it, or tells it to do something.',
  chatter: 'The message talks about Tierra the company or its team, or speaks to the people in the group, not to the assistant.',
} as const

const PDF_CRITERIA = {
  customer_po: 'A purchase order a customer (buyer) issues to Tierra Food India (the seller/vendor) to buy goods.',
  tierra_document: 'A document Tierra issues: its sales order, invoice, quotation, delivery challan or e-way bill, or Tierra\'s own purchase order to a supplier.',
  other: 'Anything else: a statement, price list, report, letter, or a document that cannot be told.',
} as const

const PROCEED_CRITERIA = {
  proceed: 'The admin clearly says yes: go ahead with this purchase order now, so the sales order is raised (or the PO is held if materials are short).',
  hold: 'The admin wants to wait, stop, or not go ahead with this purchase order for now.',
  question: 'The admin asks something about the PO, the customer, stock, price or delivery.',
  other: 'The message is about something else, or it is not clear what the admin wants for this PO.',
} as const

function client(env: { typesafeApiKey: string }): TypeSafeClient | null {
  return env.typesafeApiKey ? new TypeSafeClient({ apiKey: env.typesafeApiKey }) : null
}

export function createCallClassifier(env: { typesafeApiKey: string }): CallClassifier | null {
  const typesafe = client(env)
  if (!typesafe) return null
  return async ({ text, group }) => {
    const response = await withTimeout(
      typesafe.systemOne({
        state: { whatsappGroup: group ?? 'a customer group', message: text },
        questions: {
          intent: choice(
            'Tierra Food India has a WhatsApp assistant called Tierra Bot that people also call "Tierra". This message was written in a WhatsApp group and contains the word Tierra. Is it speaking to the assistant? Choose chatter when unsure.',
            CALL_CRITERIA,
          ),
        },
      }),
      TIMEOUT_MS,
    )
    return { choice: response.answers.intent.choice, confidence: response.answers.intent.confidence }
  }
}

export function createPdfClassifier(env: { typesafeApiKey: string }): PdfClassifier | null {
  const typesafe = client(env)
  if (!typesafe) return null
  return async ({ text }) => {
    const response = await withTimeout(
      typesafe.systemOne({
        state: { pdfText: text.slice(0, PDF_TEXT_CHARS) },
        questions: {
          kind: choice(
            'This is the text of a PDF received by Tierra Food India, a snack maker that sells to retailers. What kind of document is it?',
            PDF_CRITERIA,
          ),
        },
      }),
      TIMEOUT_MS,
    )
    return { choice: response.answers.kind.choice, confidence: response.answers.kind.confidence }
  }
}

export function createProceedClassifier(env: { typesafeApiKey: string }): ProceedClassifier | null {
  const typesafe = client(env)
  if (!typesafe) return null
  return async ({ po, text }) => {
    const response = await withTimeout(
      typesafe.systemOne({
        state: { waitingPurchaseOrder: po, adminMessage: text },
        questions: {
          intent: choice(
            'A customer purchase order received by Tierra Food India is waiting for the admin to say whether to proceed. What does this WhatsApp message from the admin mean for that PO? Choose question or other when unsure.',
            PROCEED_CRITERIA,
          ),
        },
      }),
      TIMEOUT_MS,
    )
    return { choice: response.answers.intent.choice, confidence: response.answers.intent.confidence }
  }
}

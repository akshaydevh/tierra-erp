import { describe, expect, it } from 'vitest'
import type { Approval } from '../db/types'
import type { ApprovalIntentClassifier } from './approval-intent'
import { classify } from './approvals'
import type { AgentDeps } from './deps'
import { LlmUnavailableError } from './llm'

const approval = { id: 'apr_1', subjectId: 'so_1' } as Approval

function depsWith(approvalIntent: ApprovalIntentClassifier | null, seen: string[] = []): AgentDeps {
  return {
    store: { getSalesOrder: async () => ({ docNo: 'TSO/26-27/0001', partyName: 'Northwind', total: 1000 }) },
    chatModel: async () => {
      seen.push('chat model')
      throw new LlmUnavailableError()
    },
    approvalIntent,
  } as unknown as AgentDeps
}

describe('approval intent', () => {
  it('asks TypeSafe first and passes it the order and the message', async () => {
    const inputs: unknown[] = []
    const seen: string[] = []
    const deps = depsWith(async (input) => {
      inputs.push(input)
      return { intent: 'approve', confidence: 0.9 }
    }, seen)
    expect(await classify(deps, approval, 'yes go ahead')).toEqual({ intent: 'approve', note: null })
    expect(inputs).toEqual([{ order: 'TSO/26-27/0001 (Northwind, ₹1000)', text: 'yes go ahead' }])
    expect(seen).toEqual([])
  })

  it('keeps the words as the send-back note, and the text after "send back:" when there is one', async () => {
    const deps = depsWith(async () => ({ intent: 'send_back', confidence: 0.8 }))
    expect(await classify(deps, approval, 'make line 2 cartons not pieces')).toEqual({ intent: 'send_back', note: 'make line 2 cartons not pieces' })
    expect(await classify(deps, approval, 'send back: wrong rate')).toEqual({ intent: 'send_back', note: 'wrong rate' })
  })

  it('treats a low-confidence answer or a TypeSafe failure as a question, never an approval', async () => {
    expect(await classify(depsWith(async () => ({ intent: 'approve', confidence: 0.4 })), approval, 'fine')).toEqual({ intent: 'question', note: null })
    const down = depsWith(async () => {
      throw new Error('TypeSafe did not answer within 30 s')
    })
    expect(await classify(down, approval, 'ok')).toEqual({ intent: 'question', note: null })
  })

  it('falls back to the chat model without a TypeSafe key', async () => {
    const seen: string[] = []
    expect(await classify(depsWith(null, seen), approval, 'ok')).toEqual({ intent: 'question', note: null })
    expect(seen).toEqual(['chat model'])
  })
})

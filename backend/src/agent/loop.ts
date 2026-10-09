import type { ChatModel, LlmMessage } from './llm'
import { LlmUnavailableError } from './llm'
import { llmTools, runToolCall, type AgentTool, type Effect, type ToolContext, type ToolRun } from './tools'

export const MAX_ROUNDS = 6
export const BUDGET_MS = 40_000
export const COULD_NOT_FINISH = 'Tierra Bot could not finish that — try asking more specifically.'
export const NOT_CONFIGURED = 'Tierra Bot cannot answer questions right now. The Tierra team will reply.'

export type LoopInput = {
  model: ChatModel
  system: string
  history: LlmMessage[]
  user: string
  tools: readonly AgentTool[]
  ctx: ToolContext
  budgetMs?: number
  maxRounds?: number
}

export type LoopResult = {
  status: 'answered' | 'failed' | 'unavailable'
  /** The reply to send: the model's answer, or the fallback line. */
  text: string
  /** Side effects the tools queued; only for an answered turn. */
  effects: Effect[]
  toolRuns: ToolRun[]
  /** Everything the model saw and said, for the eval and the tests' leak checks. */
  messages: LlmMessage[]
  rounds: number
}

class BudgetExceeded extends Error {
  constructor() {
    super('The agent ran out of time')
  }
}

/** Settles with the work, or rejects once the budget's signal fires, even if the work ignores the signal. */
function withinBudget<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new BudgetExceeded())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new BudgetExceeded())
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

/**
 * The tool loop: at most 6 model rounds within 40 s. Each round the model either calls tools (their results, cut to
 * ~4 KB, go back to it) or answers. The last round offers no tools, so the model has to answer with what it has.
 * A model failure, a timeout or an empty answer give the fallback line and no side effects.
 */
export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const maxRounds = input.maxRounds ?? MAX_ROUNDS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), input.budgetMs ?? BUDGET_MS)
  const messages: LlmMessage[] = [
    { role: 'system', content: input.system },
    ...input.history,
    { role: 'user', content: input.user },
  ]
  const offered = llmTools(input.tools)
  const toolRuns: ToolRun[] = []
  let rounds = 0
  const done = (status: LoopResult['status'], text: string): LoopResult => ({
    status,
    text,
    effects: status === 'answered' ? input.ctx.effects : [],
    toolRuns,
    messages,
    rounds,
  })
  try {
    while (rounds < maxRounds) {
      rounds += 1
      const last = rounds === maxRounds
      const response = await withinBudget(
        input.model({ messages, tools: last ? [] : offered, signal: controller.signal }),
        controller.signal,
      )
      if (response.toolCalls.length === 0 || last) {
        const text = response.content?.trim()
        if (!text) return done('failed', COULD_NOT_FINISH)
        messages.push({ role: 'assistant', content: text })
        return done('answered', text)
      }
      messages.push({ role: 'assistant', content: response.content, tool_calls: response.toolCalls })
      for (const call of response.toolCalls) {
        const run = await withinBudget(runToolCall(input.ctx, input.tools, call), controller.signal)
        toolRuns.push(run)
        messages.push({ role: 'tool', tool_call_id: call.id, content: run.result })
      }
    }
    return done('failed', COULD_NOT_FINISH)
  } catch (error) {
    if (error instanceof LlmUnavailableError) return done('unavailable', NOT_CONFIGURED)
    if (!(error instanceof BudgetExceeded)) console.error('The agent loop failed', error)
    return done('failed', COULD_NOT_FINISH)
  } finally {
    clearTimeout(timer)
  }
}

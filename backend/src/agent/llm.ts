import { samplingParams, type ReasoningEffort } from './model-params'

/**
 * The chat model behind the agent: an OpenAI-compatible /chat/completions endpoint with tool calling
 * (OPENAI_BASE_URL, OPENAI_API_KEY, OPENAI_AGENT_MODEL). Tests swap in a scripted ChatModel.
 */

export type LlmToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export type LlmTool = {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export type ChatRequest = {
  messages: LlmMessage[]
  tools: LlmTool[]
  signal: AbortSignal
}

export type ChatResponse = {
  content: string | null
  toolCalls: LlmToolCall[]
}

export type ChatModel = (request: ChatRequest) => Promise<ChatResponse>

/** No API key: the agent says it cannot answer instead of trying. */
export class LlmUnavailableError extends Error {
  constructor() {
    super('The chat model is not configured (OPENAI_API_KEY is empty)')
    this.name = 'LlmUnavailableError'
  }
}

export type LlmEnv = {
  openaiBaseUrl: string
  openaiApiKey: string
  openaiAgentModel: string
  /** Reasoning effort for agent calls without tools; tool calls on GPT-5.4+ always use "none". */
  openaiAgentReasoningEffort: ReasoningEffort
}

type CompletionPayload = {
  choices?: Array<{ message?: { content?: string | null; tool_calls?: LlmToolCall[] } }>
}

export function createChatModel(env: LlmEnv): ChatModel {
  return async ({ messages, tools, signal }) => {
    if (!env.openaiApiKey) throw new LlmUnavailableError()
    const response = await fetch(`${env.openaiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { authorization: `Bearer ${env.openaiApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.openaiAgentModel,
        ...samplingParams(env.openaiAgentModel, {
          temperature: 0.1,
          effort: env.openaiAgentReasoningEffort,
          withTools: tools.length > 0,
        }),
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
      }),
    })
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      throw new Error(`The chat model failed (${response.status}) ${detail}`.trim())
    }
    const payload = (await response.json()) as CompletionPayload
    const message = payload.choices?.[0]?.message
    if (!message) throw new Error('The chat model returned no message')
    return {
      content: message.content?.trim() || null,
      toolCalls: (message.tool_calls ?? []).filter((call) => call.type === 'function'),
    }
  }
}

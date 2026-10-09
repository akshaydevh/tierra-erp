import type { ChatModel, ChatRequest, ChatResponse, LlmMessage, LlmToolCall } from '../agent/llm'

/** One scripted model turn: a fixed response, or one computed from what the model was sent. */
export type Step = ChatResponse | ((request: SeenRequest) => ChatResponse | Promise<ChatResponse>)

/** What the model was sent on one call, copied (the loop keeps appending to its own array). */
export type SeenRequest = { messages: LlmMessage[]; toolNames: string[] }

let callIds = 0

export function say(text: string): ChatResponse {
  return { content: text, toolCalls: [] }
}

export function callTool(name: string, args: Record<string, unknown> = {}): LlmToolCall {
  callIds += 1
  return { id: `call_${callIds}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

export function useTools(...calls: LlmToolCall[]): ChatResponse {
  return { content: null, toolCalls: calls }
}

/**
 * A scripted chat model for deterministic tests. Each call takes the next step of the script; when the script is
 * used up it answers `fallback`. Every request is recorded, so tests can read the prompt and the tool results.
 */
export class FakeModel {
  requests: SeenRequest[] = []
  private steps: Step[] = []
  fallback: Step = say('Tierra Bot here.')
  error: Error | null = null

  script(...steps: Step[]): this {
    this.steps = [...steps]
    return this
  }

  readonly model: ChatModel = async (request: ChatRequest) => {
    const seen: SeenRequest = {
      messages: JSON.parse(JSON.stringify(request.messages)) as LlmMessage[],
      toolNames: request.tools.map((tool) => tool.function.name),
    }
    this.requests.push(seen)
    if (this.error) throw this.error
    const step = this.steps.shift() ?? this.fallback
    return typeof step === 'function' ? step(seen) : step
  }

  get calls(): number {
    return this.requests.length
  }

  last(): SeenRequest | undefined {
    return this.requests.at(-1)
  }

  /** The system prompt and user turn of the latest request. */
  system(): string {
    return (this.last()?.messages.find((message) => message.role === 'system')?.content as string | undefined) ?? ''
  }

  user(): string {
    const users = this.last()?.messages.filter((message) => message.role === 'user') ?? []
    return (users.at(-1)?.content as string | undefined) ?? ''
  }

  /** The tool results of the latest turn (its last request carries them all), as text. */
  toolResults(): string[] {
    return (this.last()?.messages ?? []).filter((message) => message.role === 'tool').map((message) => message.content as string)
  }

  /** Everything the model has seen, as one string, for leak checks. */
  transcript(): string {
    return JSON.stringify(this.requests)
  }
}

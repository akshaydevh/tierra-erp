import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChatModel, type LlmTool } from './llm'
import { asReasoningEffort, isReasoningModel, samplingParams, toolsNeedNoReasoning } from './model-params'

const tool: LlmTool = { type: 'function', function: { name: 'find_item', description: 'Find an item', parameters: { type: 'object' } } }

describe('model params', () => {
  it('tells reasoning models from chat models', () => {
    for (const model of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5-mini', 'o4-mini', 'openai/gpt-5.6-sol', 'gpt-6']) {
      expect(isReasoningModel(model)).toBe(true)
    }
    for (const model of ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1']) expect(isReasoningModel(model)).toBe(false)
  })

  it('needs reasoning "none" for tool calls from GPT-5.4 on', () => {
    expect(['gpt-5.4', 'gpt-5.6-terra', 'GPT-5.10-luna', 'gpt-6'].map(toolsNeedNoReasoning)).toEqual([true, true, true, true])
    expect(['gpt-5', 'gpt-5-mini', 'gpt-5.3', 'o4-mini', 'gpt-4.1'].map(toolsNeedNoReasoning)).toEqual([false, false, false, false, false])
  })

  it('sends a temperature to chat models and a reasoning effort to reasoning models', () => {
    expect(samplingParams('gpt-4o-mini', { temperature: 0.1, effort: 'low', withTools: true })).toEqual({ temperature: 0.1 })
    expect(samplingParams('gpt-5.6-terra', { temperature: 0.1, effort: 'low', withTools: true })).toEqual({ reasoning_effort: 'none' })
    expect(samplingParams('gpt-5.6-terra', { temperature: 0.1, effort: 'low', withTools: false })).toEqual({ reasoning_effort: 'low' })
    expect(samplingParams('gpt-5-mini', { temperature: 0, effort: 'medium', withTools: true })).toEqual({ reasoning_effort: 'medium' })
  })

  it('reads the effort setting and refuses a misspelt one', () => {
    expect(asReasoningEffort(undefined, 'low')).toBe('low')
    expect(asReasoningEffort(' High ', 'low')).toBe('high')
    expect(() => asReasoningEffort('fast', 'low')).toThrow(/Unknown reasoning effort "fast"/)
  })
})

describe('chat model request', () => {
  afterEach(() => vi.unstubAllGlobals())

  async function bodyFor(model: string, tools: LlmTool[]): Promise<Record<string, unknown>> {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] })))
    vi.stubGlobal('fetch', fetchMock)
    const chat = createChatModel({
      openaiBaseUrl: 'https://api.example.test/v1',
      openaiApiKey: 'key',
      openaiAgentModel: model,
      openaiAgentReasoningEffort: 'low',
    })
    await chat({ messages: [{ role: 'user', content: 'hi' }], tools, signal: AbortSignal.timeout(1000) })
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1]
    return JSON.parse(String(init.body)) as Record<string, unknown>
  }

  it('sends GPT-5.6 Terra tool turns with reasoning "none" and no temperature', async () => {
    const body = await bodyFor('gpt-5.6-terra', [tool])
    expect(body).toMatchObject({ model: 'gpt-5.6-terra', reasoning_effort: 'none', tool_choice: 'auto' })
    expect(body).not.toHaveProperty('temperature')
  })

  it('keeps the configured effort for Terra turns without tools', async () => {
    expect(await bodyFor('gpt-5.6-terra', [])).toMatchObject({ reasoning_effort: 'low' })
  })

  it('keeps temperature 0.1 for gpt-4o-mini', async () => {
    const body = await bodyFor('gpt-4o-mini', [tool])
    expect(body).toMatchObject({ temperature: 0.1 })
    expect(body).not.toHaveProperty('reasoning_effort')
  })
})

/**
 * Request settings that differ by OpenAI model family.
 * - Older chat models (gpt-4o, gpt-4.1 ...) take a temperature and no reasoning effort.
 * - Reasoning models (o-series, gpt-5 and later) reject a custom temperature and take reasoning_effort instead.
 * - From GPT-5.4 on, Chat Completions only allows tool calling with reasoning_effort "none".
 */

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/** "openai/gpt-5.6-terra" and "gpt-5.6-terra" are the same model. */
function modelName(model: string): string {
  return model.trim().toLowerCase().replace(/^.*\//, '')
}

export function isReasoningModel(model: string): boolean {
  return /^(?:o\d|gpt-(?:[5-9]|\d{2,}))/.test(modelName(model))
}

/** GPT-5.4 and later: tool calls over Chat Completions need reasoning_effort "none". */
export function toolsNeedNoReasoning(model: string): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/.exec(modelName(model))
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 5 || (major === 5 && minor >= 4)
}

export function asReasoningEffort(value: string | undefined, fallback: ReasoningEffort): ReasoningEffort {
  const wanted = value?.trim().toLowerCase()
  if (!wanted) return fallback
  if ((REASONING_EFFORTS as readonly string[]).includes(wanted)) return wanted as ReasoningEffort
  throw new Error(`Unknown reasoning effort "${value}". Use one of ${REASONING_EFFORTS.join(', ')}.`)
}

/** The temperature or reasoning_effort part of a /chat/completions body for this model. */
export function samplingParams(
  model: string,
  options: { temperature: number; effort: ReasoningEffort; withTools: boolean },
): Record<string, unknown> {
  if (!isReasoningModel(model)) return { temperature: options.temperature }
  const effort = options.withTools && toolsNeedNoReasoning(model) ? 'none' : options.effort
  return { reasoning_effort: effort }
}

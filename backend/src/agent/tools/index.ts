import { z } from 'zod/v4'
import { isNotImported } from '../../queries/meta'
import type { LlmTool, LlmToolCall } from '../llm'
import type { Audience } from '../scope'
import { documentTools } from './documents'
import { costingTools } from './costing'
import { financeTools } from './finance'
import { hrTools } from './hr'
import { reportTools } from './reports'
import { masterTools } from './masters'
import { orderTools } from './orders'
import { productionTools } from './production'
import { purchasingTools } from './purchasing'
import { salesTools } from './sales'
import { salesOrderTools } from './sales-orders'
import { stockTools } from './stock'
import { taskTools } from './tasks'
import type { AgentTool, ToolContext } from './types'

export type { AgentTool, Effect, ToolContext } from './types'

export const CATALOGUE: readonly AgentTool[] = [
  ...masterTools,
  ...salesTools,
  ...stockTools,
  ...orderTools,
  ...salesOrderTools,
  ...productionTools,
  ...purchasingTools,
  ...documentTools,
  ...taskTools,
  ...financeTools,
  ...reportTools,
  ...costingTools,
  ...hrTools,
]

/**
 * The tools an audience may call. Public: none. A customer group: party-safe tools only. Internal: every tool the
 * speaker's role is allowed.
 */
export function toolsFor(audience: Audience, catalogue: readonly AgentTool[] = CATALOGUE): AgentTool[] {
  if (audience.kind === 'public') return []
  if (audience.kind === 'party') return catalogue.filter((tool) => tool.scope === 'party')
  return catalogue.filter((tool) => tool.roles.includes(audience.role))
}

export function llmTools(tools: readonly AgentTool[]): LlmTool[] {
  return tools.map((tool) => {
    const { $schema: _schema, ...parameters } = z.toJSONSchema(tool.args) as Record<string, unknown>
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters } }
  })
}

/** Tool results go back to the model whole up to this size; longer lists are cut to their first rows. */
export const RESULT_LIMIT = 4096
const ROWS_KEPT = 10
const TOO_LARGE = 'The result was too large to show; ask for something narrower.'

type Json = Record<string, unknown>

/** A list inside a result, and the object that holds it (whose `more` counts the rows dropped from it). */
type Slot = { owner: Json; key: string; list: unknown[] }

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Where an object counts the rows dropped from its lists: `more: { rows: 15 }` ("more" taken? "_more"). */
function moreKey(owner: Json): string {
  return 'more' in owner && !isObject(owner.more) ? '_more' : 'more'
}

function countDropped(owner: Json, key: string, n: number): void {
  const field = moreKey(owner)
  const more = (owner[field] ??= {}) as Record<string, number>
  more[key] = (more[key] ?? 0) + n
}

/**
 * A copy of the result with every list cut to its first 10 rows. Rows dropped are counted in the owning object's
 * `more` ({ rows: [...10], more: { rows: 390 } }); totals and every other plain field are kept as they are.
 */
function trimLists(value: unknown, depth = 0): unknown {
  if (Array.isArray(value)) return value.slice(0, ROWS_KEPT).map((item) => trimLists(item, depth + 1))
  if (!isObject(value) || depth >= 6) return value
  const out: Json = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = trimLists(item, depth + 1)
    if (Array.isArray(item) && item.length > ROWS_KEPT) countDropped(out, key, item.length - ROWS_KEPT)
  }
  return out
}

function slots(value: unknown): Slot[] {
  const found: Slot[] = []
  const visit = (node: unknown) => {
    if (Array.isArray(node)) node.forEach(visit)
    else if (isObject(node)) {
      for (const [key, item] of Object.entries(node)) {
        if (Array.isArray(item)) found.push({ owner: node, key, list: item })
        visit(item)
      }
    }
  }
  visit(value)
  return found
}

/** What is left when even the rows do not fit: the plain top-level fields (totals, found, docNo ...). */
function headline(value: unknown): Json {
  const out: Json = { truncated: true, message: TOO_LARGE }
  if (!isObject(value)) return out
  for (const [key, item] of Object.entries(value)) {
    if (item === null || typeof item === 'number' || typeof item === 'boolean') out[key] = item
    else if (typeof item === 'string') out[key] = item.length > 200 ? `${item.slice(0, 200)}…` : item
    else if (isObject(item) && (key === 'totals' || key === 'more')) out[key] = item
  }
  return out
}

/**
 * A tool result as the model sees it: valid JSON of at most ~4 KB. Lists keep their first 10 rows and the owning
 * object counts the rest in `more`; if that is still too long, rows come off the longest list (and are counted) until
 * it fits. Totals worked out in SQL are plain fields and never cut. Last resort: the plain fields alone.
 */
export function capResult(value: unknown, limit = RESULT_LIMIT): string {
  const trimmed = trimLists(Array.isArray(value) ? { rows: value } : value)
  let json = JSON.stringify(trimmed) ?? 'null'
  while (json.length > limit) {
    const longest = slots(trimmed)
      .filter((slot) => slot.list.length > 0)
      .sort((a, b) => b.list.length - a.list.length || JSON.stringify(b.list).length - JSON.stringify(a.list).length)[0]
    if (!longest) break
    longest.list.pop()
    countDropped(longest.owner, longest.key, 1)
    json = JSON.stringify(trimmed)
  }
  if (json.length <= limit) return json
  const fallback = JSON.stringify(headline(trimmed))
  return fallback.length <= limit ? fallback : JSON.stringify({ truncated: true, message: TOO_LARGE })
}

export type ToolRun = { name: string; args: unknown; result: string; ok: boolean }

/**
 * Runs one tool call from the model. A tool outside the audience's set, bad arguments or a failing query come back
 * as an error the model can read, never as data.
 */
export async function runToolCall(ctx: ToolContext, allowed: readonly AgentTool[], call: LlmToolCall): Promise<ToolRun> {
  const name = call.function.name
  const tool = allowed.find((candidate) => candidate.name === name)
  let args: unknown = null
  const fail = (error: string): ToolRun => ({ name, args, ok: false, result: JSON.stringify({ error }) })
  if (!tool) return fail(`The tool ${name} is not available here.`)
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as unknown) : {}
  } catch {
    return fail('The arguments were not valid JSON.')
  }
  const parsed = tool.args.safeParse(args ?? {})
  if (!parsed.success) {
    return fail(`Bad arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || 'args'} ${issue.message}`).join('; ')}`)
  }
  try {
    const value = await tool.run(ctx, parsed.data)
    return { name, args: parsed.data, ok: true, result: capResult(value) }
  } catch (error) {
    if (isNotImported(error)) return fail('SAP data has not been imported yet.')
    console.error(`Agent tool ${name} failed`, error)
    return fail('The lookup failed.')
  }
}

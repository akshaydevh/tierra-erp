import { z } from 'zod/v4'
import { describe, expect, it } from 'vitest'
import { MemoryStore } from '../db/memory'
import { FakeModel, callTool, say, useTools } from '../test/fake-llm'
import type { AgentDeps } from './deps'
import { COULD_NOT_FINISH, MAX_ROUNDS, runLoop } from './loop'
import type { Audience } from './scope'
import { CATALOGUE, RESULT_LIMIT, capResult, toolsFor } from './tools'
import { defineTool, type ToolContext } from './tools/types'

const alex: Audience = { kind: 'internal', userId: 'usr_alex', name: 'Alex Thomas', role: 'admin' }
const anju: Audience = { kind: 'internal', userId: 'usr_anju', name: 'Anju', role: 'office' }
const alpha: Audience = {
  kind: 'party',
  partyGroupId: 'pty_a',
  name: 'Alpha',
  cardCodes: ['ZC001'],
  pans: [],
  groupSubject: null,
  speakerName: null,
}

const echo = defineTool({
  name: 'echo_rows',
  description: 'Returns n rows',
  scope: 'internal',
  args: z.object({ n: z.number() }),
  async run(_ctx, args) {
    return { total: args.n, rows: Array.from({ length: args.n }, (_, i) => ({ docNo: `SO/26-27/${i + 1}`, note: 'x'.repeat(40) })) }
  },
})

const queue = defineTool({
  name: 'queue_task',
  description: 'Queues a side effect',
  scope: 'internal',
  args: z.object({}),
  async run(ctx) {
    ctx.effects.push({ kind: 'complete_task', taskId: 'tsk_1', title: 'Count cartons' })
    return { queued: true }
  },
})

const payroll = defineTool({
  name: 'payroll_summary',
  description: 'Admin only',
  scope: 'internal',
  roles: ['admin'],
  args: z.object({}),
  async run() {
    return { total: 1 }
  },
})

function context(audience: Audience = alex): ToolContext {
  return {
    deps: { store: new MemoryStore('hash') } as unknown as AgentDeps,
    audience,
    cards: audience.kind === 'internal' ? 'all' : audience.kind === 'party' ? audience.cardCodes : [],
    dataAsOf: '2026-03-31',
    referenceDay: '2026-03-31',
    messageId: 'm1',
    via: 'whatsapp',
    effects: [],
  }
}

function loop(llm: FakeModel, extra: Partial<Parameters<typeof runLoop>[0]> = {}) {
  return runLoop({ model: llm.model, system: 'system', history: [], user: 'question', tools: [echo, queue], ctx: context(), ...extra })
}

describe('the tool loop', () => {
  it('runs tool calls, feeds back the results and returns the answer', async () => {
    const llm = new FakeModel().script(useTools(callTool('echo_rows', { n: 2 })), say('SO/26-27/1 and SO/26-27/2.'))
    const result = await loop(llm)
    expect(result).toMatchObject({ status: 'answered', text: 'SO/26-27/1 and SO/26-27/2.', rounds: 2 })
    expect(result.toolRuns).toEqual([expect.objectContaining({ name: 'echo_rows', ok: true })])
    expect(llm.requests[0]?.toolNames).toEqual(['echo_rows', 'queue_task'])
    expect(llm.toolResults()[0]).toContain('SO/26-27/2')
  })

  it('keeps 10 rows of a long list and cuts every result to about 4 KB', async () => {
    const llm = new FakeModel().script(useTools(callTool('echo_rows', { n: 400 })), say('done'))
    await loop(llm)
    const result = llm.toolResults()[0]!
    expect(result.length).toBeLessThanOrEqual(RESULT_LIMIT)
    const parsed = JSON.parse(result) as { total: number; rows: unknown[]; more: { rows: number } }
    expect(parsed.total).toBe(400)
    expect(parsed.rows).toHaveLength(10)
    expect(parsed.more).toEqual({ rows: 390 })
    const wide = capResult({ total: 10, value: 123456.5, rows: Array.from({ length: 10 }, () => ({ text: 'y'.repeat(1000) })) })
    expect(wide.length).toBeLessThanOrEqual(RESULT_LIMIT)
    const cut = JSON.parse(wide) as { total: number; value: number; rows: unknown[]; more: { rows: number } }
    expect(cut).toMatchObject({ total: 10, value: 123456.5 })
    expect(cut.rows.length + cut.more.rows).toBe(10)
  })

  it('always returns valid JSON and keeps SQL totals, however the result is shaped', () => {
    // nested lists: the longest loses rows first, each owner counts its own
    const nested = capResult({
      found: true,
      totals: { salesOrders: 3, value: 99000, orderedQty: 1200, openQty: 300 },
      salesOrders: Array.from({ length: 3 }, (_, i) => ({ docNo: `SO/26-27/${i}`, lines: Array.from({ length: 40 }, (_, j) => ({ j, text: 'z'.repeat(60) })) })),
      invoices: Array.from({ length: 25 }, (_, i) => ({ docNo: `TF/26-27/${i}`, total: 10 })),
    })
    expect(nested.length).toBeLessThanOrEqual(RESULT_LIMIT)
    const parsed = JSON.parse(nested) as { totals: Record<string, number>; invoices: unknown[]; more: Record<string, number> }
    expect(parsed.totals).toEqual({ salesOrders: 3, value: 99000, orderedQty: 1200, openQty: 300 })
    expect(parsed.invoices.length + parsed.more.invoices!).toBe(25)
    // a plain array result is wrapped, never cut mid-text
    const list = capResult(Array.from({ length: 30 }, (_, i) => ({ i })))
    expect(JSON.parse(list)).toEqual({ rows: Array.from({ length: 10 }, (_, i) => ({ i })), more: { rows: 20 } })
    // nothing but one huge string: the plain fields, shortened, still JSON
    const huge = capResult({ found: true, docNo: 'SO/26-27/1', note: 'x'.repeat(10_000), total: 5 })
    expect(huge.length).toBeLessThanOrEqual(RESULT_LIMIT)
    expect(JSON.parse(huge)).toMatchObject({ truncated: true, found: true, docNo: 'SO/26-27/1', total: 5 })
    for (const size of [50, 300, 1000, 4096]) expect(() => JSON.parse(capResult({ rows: [{ t: 'q'.repeat(size * 3) }], total: 1 }, size))).not.toThrow()
  })

  it('answers tool errors to the model instead of failing: unknown tool, bad JSON, bad arguments', async () => {
    const llm = new FakeModel().script(
      useTools(
        callTool('free_stock', {}),
        { id: 'bad', type: 'function', function: { name: 'echo_rows', arguments: '{nope' } },
        callTool('echo_rows', { n: 'many' }),
      ),
      say('Sorry.'),
    )
    const result = await loop(llm)
    expect(result.status).toBe('answered')
    expect(llm.toolResults()).toEqual([
      JSON.stringify({ error: 'The tool free_stock is not available here.' }),
      JSON.stringify({ error: 'The arguments were not valid JSON.' }),
      expect.stringContaining('Bad arguments: n'),
    ])
  })

  it(`stops after ${MAX_ROUNDS} rounds, offering no tools on the last one`, async () => {
    const llm = new FakeModel()
    llm.fallback = (request) =>
      request.toolNames.length > 0 ? useTools(callTool('echo_rows', { n: 1 })) : say('Here is what I found.')
    const result = await loop(llm)
    expect(result).toMatchObject({ status: 'answered', rounds: MAX_ROUNDS, text: 'Here is what I found.' })
    expect(llm.requests.map((request) => request.toolNames.length)).toEqual([2, 2, 2, 2, 2, 0])
  })

  it('gives the fallback line and drops queued side effects when the model runs out of time', async () => {
    const llm = new FakeModel().script(useTools(callTool('queue_task')), () => new Promise<never>(() => undefined))
    const started = Date.now()
    const result = await loop(llm, { budgetMs: 50 })
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(result).toMatchObject({ status: 'failed', text: COULD_NOT_FINISH, effects: [] })
  })

  it('gives the fallback line when the model fails or says nothing', async () => {
    const failing = new FakeModel()
    failing.error = new Error('500 from the model')
    expect(await loop(failing)).toMatchObject({ status: 'failed', text: COULD_NOT_FINISH })
    expect(await loop(new FakeModel().script(say('  ')))).toMatchObject({ status: 'failed', text: COULD_NOT_FINISH })
  })

  it('hands over queued side effects only for an answered turn', async () => {
    const result = await loop(new FakeModel().script(useTools(callTool('queue_task')), say('Marked "Count cartons" done.')))
    expect(result.effects).toEqual([{ kind: 'complete_task', taskId: 'tsk_1', title: 'Count cartons' }])
  })
})

describe('tool scope', () => {
  it('gives public audiences no tools and customer groups only party-safe tools', () => {
    expect(toolsFor({ kind: 'public', reason: 'unknown_sender' })).toEqual([])
    expect(toolsFor({ kind: 'public', reason: 'unmapped_group' })).toEqual([])
    const party = toolsFor(alpha).map((tool) => tool.name)
    expect(party.sort()).toEqual(
      [
        'customer_po_status',
        'dispatches_on',
        'find_credit_notes',
        'find_invoices',
        'find_sales_orders',
        'get_document',
        'get_invoice',
        'get_sales_order',
        'send_document',
      ].sort(),
    )
  })

  it('gives internal audiences the tools their role allows', () => {
    expect(toolsFor(alex, [payroll]).map((tool) => tool.name)).toEqual(['payroll_summary'])
    expect(toolsFor(anju, [payroll]).map((tool) => tool.name)).toEqual([])
    expect(toolsFor(alex).map((tool) => tool.name)).toEqual(CATALOGUE.map((tool) => tool.name))
  })

  it('keeps payroll, attendance and leave to the admin alone', () => {
    const hr = ['payroll_summary', 'attendance', 'leave_requests']
    const joshy: Audience = { kind: 'internal', userId: 'usr_joshy', name: 'Joshy', role: 'manager' }
    for (const name of hr) {
      expect(toolsFor(alex).map((tool) => tool.name)).toContain(name)
      expect(toolsFor(joshy).map((tool) => tool.name)).not.toContain(name)
      expect(toolsFor(anju).map((tool) => tool.name)).not.toContain(name)
      expect(toolsFor(alpha).map((tool) => tool.name)).not.toContain(name)
    }
  })

  it('keeps finance and the daily report to the manager and the admin, and the daily inputs to the office and the admin', () => {
    const finance = ['bank_position', 'payments', 'party_balance', 'ageing', 'pending_payment_approvals', 'find_journal_entries', 'daily_report', 'production_cost', 'sku_margin']
    const hr = ['payroll_summary', 'attendance', 'leave_requests']
    const joshy: Audience = { kind: 'internal', userId: 'usr_joshy', name: 'Joshy', role: 'manager' }
    const office = toolsFor(anju).map((tool) => tool.name)
    const manager = toolsFor(joshy).map((tool) => tool.name)
    const admin = toolsFor(alex).map((tool) => tool.name)
    for (const name of finance) {
      expect(office).not.toContain(name)
      expect(manager).toContain(name)
      expect(admin).toContain(name)
    }
    expect(office).toContain('set_daily_inputs')
    expect(admin).toContain('set_daily_inputs')
    expect(manager).not.toContain('set_daily_inputs')
    expect(office).toEqual(CATALOGUE.filter((tool) => !finance.includes(tool.name) && !hr.includes(tool.name)).map((tool) => tool.name))
    expect(toolsFor(alpha).map((tool) => tool.name)).not.toContain('bank_position')
  })

  it('refuses a tool the audience was not offered, even if the model names it', async () => {
    const llm = new FakeModel().script(useTools(callTool('payroll_summary')), say('No.'))
    await runLoop({
      model: llm.model,
      system: 's',
      history: [],
      user: 'q',
      tools: toolsFor(anju, [payroll]),
      ctx: context(anju),
    })
    expect(llm.requests[0]?.toolNames).toEqual([])
    expect(llm.toolResults()).toEqual([JSON.stringify({ error: 'The tool payroll_summary is not available here.' })])
  })
})

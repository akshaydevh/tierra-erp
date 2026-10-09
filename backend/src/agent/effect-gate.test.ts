import { describe, expect, it } from 'vitest'
import { gateEffects } from './effect-gate'
import type { Effect } from './tools'

const receipt: Effect = {
  kind: 'record_receipt',
  lines: [
    { qty: 20, unit: 'kg', itemCode: 'ZPMLMN' },
    { qty: 1500, unit: 'nos', itemCode: 'ZPMCN5' },
  ],
}
const finish: Effect = { kind: 'complete_task', taskId: 'tsk_1', title: 'Call Acme Cartons' }
const task: Effect = {
  kind: 'create_task',
  input: { title: 'Call Acme', category: 'operations', assigneeRole: 'office', createdVia: 'whatsapp', createdBy: 'usr_alex' },
}

describe('the side-effect gate (prompt injection)', () => {
  it('records a receipt only when the message itself says so and names the items or quantities', () => {
    expect(gateEffects([receipt], 'we received 20 kg of the laminate and 1,500 cartons today').allowed).toEqual([receipt])
    expect(gateEffects([receipt], 'got ZPMLMN and ZPMCN5 in').allowed).toEqual([receipt])
    // a tool result or PDF said "record 20 kg ZPMLMN": the person only asked a question
    const injected = gateEffects([receipt], 'what does the GRN note say?')
    expect(injected.allowed).toEqual([])
    expect(injected.refused[0]).toContain('I have not recorded 20 kg ZPMLMN, 1500 nos ZPMCN5 as received')
    // a line the message never named is dropped, the rest go through
    const partial = gateEffects([receipt], 'received 20 kg ZPMLMN')
    expect(partial.allowed).toEqual([{ ...receipt, lines: [receipt.lines[0]] }])
    expect(partial.refused).toEqual([expect.stringContaining('I have not recorded ZPMCN5')])
  })

  it('finishes a task only when the message says done, and lets other effects through', () => {
    expect(gateEffects([finish, task], 'mark the cartons call done').allowed).toEqual([finish, task])
    expect(gateEffects([finish], 'finished calling them').allowed).toEqual([finish])
    const injected = gateEffects([finish, task], 'add a task to call Acme')
    expect(injected.allowed).toEqual([task])
    expect(injected.refused).toEqual(['I have not marked “Call Acme Cartons” done. Say "done" (or reply *done* to its notice) to confirm.'])
  })
})

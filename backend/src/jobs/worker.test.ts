import { describe, expect, it } from 'vitest'
import type { AgentDeps } from '../agent/handle-message'
import { MemoryStore } from '../db/memory'
import type { JobRecord } from '../db/types'
import type { EvolutionClient } from '../whatsapp/evolution'
import type { IncomingMessage } from '../whatsapp/parse'
import { KEEP_JOBS_MS, incomingJob, inlineEnqueue, retryDelayMs, runJob, settleJob, startWorker, workOnce } from './worker'

const now = new Date('2026-10-01T09:00:00.000Z')

type Gate = { failures: number; hold: Map<string, Promise<void>> }

function fakeEvolution(sent: Array<{ number: string; text: string }>, gate: Gate): EvolutionClient {
  let count = 0
  return {
    createInstance: async () => ({ qrBase64: null }),
    deleteInstance: async () => undefined,
    sendText: async (number, text) => {
      await gate.hold.get(number)
      if (gate.failures > 0) {
        gate.failures -= 1
        throw new Error('gateway down')
      }
      sent.push({ number, text })
      count += 1
      return { messageId: `out-${count}` }
    },
    sendReaction: async () => undefined,
    sendMedia: async () => ({ messageId: null }),
    downloadMedia: async () => ({ base64: '', mimeType: 'application/pdf', fileName: 'x.pdf' }),
    fetchOwnerPhone: async () => null,
    fetchAllGroups: async () => [],
    ensureWebhook: async () => undefined,
  }
}

/** No SAP import in these tests: every read fails the way it does before the first import. */
const notImported = Object.assign(
  () => {
    throw Object.assign(new Error('relation "erp.import_info" does not exist'), { code: '42P01' })
  },
  { unsafe: () => undefined },
) as unknown as AgentDeps['sapSql']

function setup() {
  const store = new MemoryStore('hash')
  const sent: Array<{ number: string; text: string }> = []
  const gate: Gate = { failures: 0, hold: new Map() }
  let modelCalls = 0
  const deps: AgentDeps = {
    store,
    evolution: fakeEvolution(sent, gate),
    readPurchaseOrder: async () => {
      throw new Error('not used')
    },
    dataBrief: async () => {
      throw new Error('not used')
    },
    sapSql: notImported,
    chatModel: async () => {
      modelCalls += 1
      return { content: 'Hello from the worker.', toolCalls: [] }
    },
    enqueue: async () => true,
    botMode: 'personal',
    now: () => now,
  }
  return { deps, store, sent, gate, modelCalls: () => modelCalls }
}

function message(id: string, text: string): IncomingMessage {
  return {
    id,
    remoteJid: '919812345678@s.whatsapp.net',
    fromMe: false,
    text,
    quotedText: null,
    quotedId: null,
    quotedParticipant: null,
    mentionedJids: [],
    participantJid: null,
    participantAltJid: null,
    aliasJid: null,
    control: false,
    kind: 'text',
    reaction: null,
    pdf: null,
    raw: null,
    embeddedBase64: null,
  }
}

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting')
}

async function queued(store: MemoryStore, kind: string, payload: Record<string, unknown>, maxAttempts = 3) {
  const job = await store.enqueueJob({ kind, payload, runAfter: now, maxAttempts })
  return job!
}

describe('job worker', () => {
  it("never runs two turns of one chat at once: the later one waits for the earlier to finish", async () => {
    const { store } = setup()
    const a1 = await store.enqueueJob({ ...incomingJob(message('a1', 'first'), 'personal'), runAfter: now })
    const a2 = await store.enqueueJob({ ...incomingJob(message('a2', 'second'), 'personal'), runAfter: now })
    const b1 = await store.enqueueJob({ ...incomingJob({ ...message('b1', 'other chat'), remoteJid: '919800000000@s.whatsapp.net' }, 'personal'), runAfter: now })
    expect((await store.claimJobs(5, 30_000, now)).map((job) => job.id)).toEqual([a1!.id, b1!.id])
    expect(await store.claimJobs(5, 30_000, now)).toEqual([])
    await store.completeJob(a1!.id)
    expect((await store.claimJobs(5, 30_000, now)).map((job) => job.id)).toEqual([a2!.id])
  })

  it('sends a task notice for a task.notify job', async () => {
    const { deps, store, sent } = setup()
    await store.saveRelation({ userId: 'usr_joshy', phoneNumber: '919700000001' })
    const task = await store.createTask({
      title: 'Check cartons',
      category: 'operations',
      assigneeId: 'usr_joshy',
      assigneeRole: 'manager',
      createdBy: 'usr_alex',
    })
    await runJob(deps, await queued(store, 'task.notify', { taskId: task.id }))
    expect(sent).toEqual([expect.objectContaining({ number: '919700000001' })])
    expect((await store.getTask(task.id))?.waMessageId).toBe('out-1')

    await runJob(deps, await queued(store, 'task.notify', { taskId: task.id }))
    expect(sent).toHaveLength(1)
  })

  it('handles a wa.incoming job as a WhatsApp turn', async () => {
    const { deps, sent, modelCalls } = setup()
    const message = {
      id: 'in-1',
      remoteJid: '919812345678@s.whatsapp.net',
      fromMe: false,
      text: 'hello',
      quotedText: null,
      quotedId: null,
      quotedParticipant: null,
      mentionedJids: [],
      participantJid: null,
      participantAltJid: null,
      aliasJid: null,
      control: false,
      kind: 'text',
      reaction: null,
      pdf: null,
      raw: null,
      embeddedBase64: null,
    }
    await runJob(deps, await queued(deps.store as MemoryStore, 'wa.incoming', { message, audience: 'personal' }))
    expect(modelCalls()).toBe(1)
    expect(sent.map((row) => row.text)).toEqual(['> 🧞‍♂️ Tierra Bot:\n\nHello from the worker.'])
  })

  it('rejects a job kind it does not know', async () => {
    const { deps, store } = setup()
    await expect(runJob(deps, await queued(store, 'mystery', {}))).rejects.toThrow('Unknown job kind mystery')
  })

  it('backs off a failed job and gives up after the last attempt', async () => {
    const { deps, store } = setup()
    const job = await queued(store, 'mystery', {}, 2)
    const [first] = await store.claimJobs(1, 60_000, now)
    await settleJob(deps, first!)
    expect(await store.getJob(job.id)).toMatchObject({
      status: 'queued',
      attempts: 1,
      lastError: 'Unknown job kind mystery',
      runAfter: new Date(now.getTime() + 10_000).toISOString(),
    })

    const [second] = await store.claimJobs(1, 60_000, new Date(now.getTime() + 10_000))
    await settleJob(deps, second!)
    expect(await store.getJob(job.id)).toMatchObject({ status: 'failed', attempts: 2 })
  })

  it('caps the retry delay at five minutes', () => {
    expect(retryDelayMs(1)).toBe(10_000)
    expect(retryDelayMs(3)).toBe(40_000)
    expect(retryDelayMs(10)).toBe(300_000)
  })

  it('claims ready jobs, runs them and marks them done', async () => {
    const { deps, store } = setup()
    const task = await store.createTask({ title: 'No phone', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    const job = await queued(store, 'task.notify', { taskId: task.id })
    expect(await workOnce(deps)).toBe(true)
    expect((await store.getJob(job.id))?.status).toBe('done')
    expect(await workOnce(deps)).toBe(false)
  })

  it('requeues a job whose worker died, and runs it once', async () => {
    const { deps, store } = setup()
    const task = await store.createTask({ title: 'Lost', category: 'operations', assigneeId: null, createdBy: 'usr_alex' })
    const job = (await store.enqueueJob({
      kind: 'task.notify',
      payload: { taskId: task.id },
      runAfter: new Date(now.getTime() - 10_000),
    }))!
    expect(await store.claimJobs(1, 1_000, new Date(now.getTime() - 5_000))).toHaveLength(1)
    const worker = startWorker(deps, { pollMs: 5, reapMs: 5 })
    await until(async () => (await store.getJob(job.id))?.status === 'done')
    await worker.stop()
    expect(await store.getJob(job.id)).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('runs a WhatsApp turn at most once, even when its worker dies', async () => {
    const { deps, store } = setup()
    const queuedTurn = incomingJob(message('in-once', 'hi'), 'personal')
    expect(queuedTurn.maxAttempts).toBe(1)
    const job = (await store.enqueueJob({ ...queuedTurn, runAfter: now }))!
    await store.claimJobs(1, 1_000, now)
    expect(await store.requeueExpiredJobs(new Date(now.getTime() + 2_000))).toBe(0)
    expect(await store.getJob(job.id)).toMatchObject({ status: 'failed', lastError: 'Lease expired' })

    const broken = (await store.enqueueJob({ ...incomingJob(message('in-broken', 'hi'), 'personal'), runAfter: now }))!
    deps.evolution.sendText = async () => {
      throw new Error('gateway down')
    }
    const [claimed] = await store.claimJobs(1, 60_000, now)
    await settleJob(deps, claimed!)
    expect(await store.getJob(broken.id)).toMatchObject({ status: 'failed', lastError: 'gateway down' })
  })

  it('keeps a free slot working while another job is slow', async () => {
    const { deps, store, sent, gate } = setup()
    let release = () => {}
    gate.hold.set('919700000001', new Promise<void>((resolve) => (release = resolve)))
    await store.saveRelation({ userId: 'usr_joshy', phoneNumber: '919700000001' })
    await store.saveRelation({ userId: 'usr_anju', phoneNumber: '919812345678' })
    const slow = await store.createTask({ title: 'Slow', category: 'operations', assigneeId: 'usr_joshy', createdBy: 'usr_alex' })
    const quick = await store.createTask({ title: 'Quick', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    const slowJob = await queued(store, 'task.notify', { taskId: slow.id })
    const worker = startWorker(deps, { pollMs: 5, concurrency: 2 })
    await until(async () => (await store.getJob(slowJob.id))?.status === 'running')
    const quickJobs = [await queued(store, 'task.notify', { taskId: quick.id }), await queued(store, 'x.unknown', {}, 1)]
    await until(async () => (await Promise.all(quickJobs.map((job) => store.getJob(job.id)))).every((job) => job?.status !== 'queued' && job?.status !== 'running'))
    expect(sent.map((row) => row.number)).toEqual(['919812345678'])
    expect((await store.getJob(slowJob.id))?.status).toBe('running')
    release()
    await until(async () => (await store.getJob(slowJob.id))?.status === 'done')
    await worker.stop()
    expect(sent.map((row) => row.number)).toEqual(['919812345678', '919700000001'])
  })

  it('prunes finished jobs older than a week and keeps the rest', async () => {
    const { deps, store } = setup()
    const done = await queued(store, 'x', {})
    const failed = await queued(store, 'x', {})
    const waiting = await queued(store, 'x', {})
    await store.completeJob(done.id)
    await store.failJob(failed.id, 'boom', null)
    expect(await store.pruneJobs(new Date(Date.now() - 1_000))).toBe(0)
    deps.now = () => new Date(Date.now() + KEEP_JOBS_MS + 1_000)
    const worker = startWorker(deps, { pollMs: 5 })
    await until(async () => store.jobs.length === 1)
    await worker.stop()
    expect(store.jobs.map((job) => job.id)).toEqual([waiting.id])
  })

  it('runs an inline job once per idempotency key', async () => {
    const { deps, store, sent } = setup()
    await store.saveRelation({ userId: 'usr_anju', phoneNumber: '919812345678' })
    const task = await store.createTask({ title: 'Once', category: 'operations', assigneeId: 'usr_anju', createdBy: 'usr_alex' })
    const enqueue = inlineEnqueue(deps)
    const job = { kind: 'task.notify', payload: { taskId: task.id }, idempotencyKey: `task.notify:${task.id}:usr_anju` }
    await enqueue(job)
    await store.markTaskNotified(task.id, null, now)
    await store.updateTaskAssignment(task.id, { assigneeId: 'usr_anju', assigneeRole: null })
    await enqueue(job)
    expect(sent).toHaveLength(1)
    expect(store.jobs.map((row) => row.status)).toEqual(['done'])
  })

  it('marks an inline job failed and rethrows when it breaks', async () => {
    const { deps, store } = setup()
    await expect(inlineEnqueue(deps)({ kind: 'mystery', payload: {} })).rejects.toThrow('Unknown job kind')
    expect(store.jobs.map((row) => row.status)).toEqual(['failed'])
  })

  it('polls until stopped', async () => {
    const { deps, store } = setup()
    const task = await store.createTask({ title: 'Poll', category: 'operations', assigneeId: null, createdBy: 'usr_alex' })
    const job: JobRecord = await queued(store, 'task.notify', { taskId: task.id })
    const worker = startWorker(deps, { pollMs: 5 })
    for (let i = 0; i < 50 && (await store.getJob(job.id))?.status !== 'done'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await worker.stop()
    expect((await store.getJob(job.id))?.status).toBe('done')
  })
})

describe('task notice jobs', () => {
  async function heldByJoshy() {
    const ctx = setup()
    await ctx.store.saveRelation({ userId: 'usr_joshy', phoneNumber: '919700000001' })
    const task = await ctx.store.createTask({
      title: 'Check cartons',
      category: 'operations',
      assigneeId: 'usr_joshy',
      createdBy: 'usr_alex',
    })
    return { ...ctx, task }
  }

  it('sends one notice when two are queued for the same holder', async () => {
    const { deps, store, sent, task } = await heldByJoshy()
    const payload = { taskId: task.id, assigneeId: 'usr_joshy' }
    const [first, second] = [await queued(store, 'task.notify', payload), await queued(store, 'task.notify', payload)]
    await Promise.all([runJob(deps, first), runJob(deps, second)])
    expect(sent).toHaveLength(1)
    expect((await store.getTask(task.id))?.waMessageId).toBe('out-1')
  })

  it('drops a notice queued for an earlier holder', async () => {
    const { deps, store, sent, task } = await heldByJoshy()
    await runJob(deps, await queued(store, 'task.notify', { taskId: task.id, assigneeId: 'usr_anju' }))
    expect(sent).toHaveLength(0)
    expect((await store.getTask(task.id))?.notifiedAt).toBeNull()
  })

  it('frees the notice when the send fails, so the retry sends it', async () => {
    const { deps, store, sent, gate, task } = await heldByJoshy()
    gate.failures = 1
    const job = await queued(store, 'task.notify', { taskId: task.id, assigneeId: 'usr_joshy' }, 30)
    const [first] = await store.claimJobs(1, 60_000, now)
    await settleJob(deps, first!)
    expect(await store.getJob(job.id)).toMatchObject({ status: 'queued', lastError: 'gateway down' })
    expect((await store.getTask(task.id))?.notifiedAt).toBeNull()

    const [retry] = await store.claimJobs(1, 60_000, new Date(now.getTime() + retryDelayMs(1)))
    await settleJob(deps, retry!)
    expect(sent).toHaveLength(1)
    expect(await store.getTask(task.id)).toMatchObject({ waMessageId: 'out-1', notifiedAt: now.toISOString() })
  })
})


import { handleIncoming, type AgentDeps } from '../agent/handle-message'
import type { JobRecord, NewJob } from '../db/types'
import { sendTaskNotice } from '../tasks/notify'
import type { ChatKind, IncomingMessage } from '../whatsapp/parse'

export type WorkerOptions = {
  pollMs?: number
  /** How many jobs run at once. Each slot claims its next job as soon as it is free. */
  concurrency?: number
  leaseMs?: number
  reapMs?: number
}

export type Worker = {
  stop(): Promise<void>
}

const BASE_RETRY_MS = 5_000
const MAX_RETRY_MS = 5 * 60_000
/** Longer than the slowest job: a PDF download, the PO reader and a few sends, each with its own timeout. */
export const LEASE_MS = 10 * 60_000
const REAP_MS = 30_000
const PRUNE_EVERY_MS = 60 * 60_000
export const KEEP_JOBS_MS = 7 * 24 * 60 * 60_000

export function retryDelayMs(attempts: number): number {
  return Math.min(BASE_RETRY_MS * 2 ** attempts, MAX_RETRY_MS)
}

/** A WhatsApp turn runs once: a rerun could create a second order, task or reply. */
export function incomingJob(message: IncomingMessage, audience: ChatKind): NewJob {
  return { kind: 'wa.incoming', payload: { message, audience }, idempotencyKey: `wa:${message.id}`, maxAttempts: 1 }
}

export async function runJob(deps: AgentDeps, job: JobRecord): Promise<void> {
  if (job.kind === 'wa.incoming') {
    const payload = job.payload as { message: IncomingMessage; audience: ChatKind }
    await handleIncoming(deps, payload.message, payload.audience)
    return
  }
  if (job.kind === 'task.notify') {
    const assigneeId = typeof job.payload.assigneeId === 'string' ? job.payload.assigneeId : undefined
    await sendTaskNotice(deps, String(job.payload.taskId), assigneeId)
    return
  }
  throw new Error(`Unknown job kind ${job.kind}`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Runs a claimed job and records the outcome: done, retry with backoff, or failed for good. */
export async function settleJob(deps: AgentDeps, job: JobRecord): Promise<void> {
  try {
    await runJob(deps, job)
    await deps.store.completeJob(job.id)
  } catch (error) {
    const retryAt =
      job.attempts < job.maxAttempts ? new Date(deps.now().getTime() + retryDelayMs(job.attempts)) : null
    console.error(`Job ${job.id} (${job.kind}) failed on attempt ${job.attempts}`, error)
    await deps.store.failJob(job.id, errorText(error), retryAt)
  }
}

/** Claims and runs one job. Returns false when nothing was ready. */
export async function workOnce(deps: AgentDeps, leaseMs = LEASE_MS): Promise<boolean> {
  const [job] = await deps.store.claimJobs(1, leaseMs, deps.now())
  if (!job) return false
  await settleJob(deps, job)
  return true
}

export function startWorker(deps: AgentDeps, options: WorkerOptions = {}): Worker {
  const pollMs = options.pollMs ?? 500
  const leaseMs = options.leaseMs ?? LEASE_MS
  let stopped = false
  let wake = () => {}
  const stopping = new Promise<void>((resolve) => {
    wake = resolve
  })
  const pause = (ms: number) =>
    Promise.race([new Promise<void>((resolve) => setTimeout(resolve, ms).unref()), stopping])

  const repeat = async (label: string, everyMs: number, work: () => Promise<boolean>) => {
    while (!stopped) {
      const busy = await work().catch((error: unknown) => {
        console.error(`Job worker ${label} failed`, error)
        return false
      })
      if (!busy) await pause(everyMs)
    }
  }

  const loops = [
    ...Array.from({ length: options.concurrency ?? 2 }, () => repeat('slot', pollMs, () => workOnce(deps, leaseMs))),
    repeat('reaper', options.reapMs ?? REAP_MS, async () => {
      await deps.store.requeueExpiredJobs(deps.now())
      return false
    }),
    repeat('pruner', PRUNE_EVERY_MS, async () => {
      await deps.store.pruneJobs(new Date(deps.now().getTime() - KEEP_JOBS_MS))
      return false
    }),
  ]

  return {
    async stop() {
      stopped = true
      wake()
      await Promise.all(loops)
    },
  }
}

/** For tests and single-process runs: queue the job, then run it straight away. */
export function inlineEnqueue(deps: AgentDeps): (job: NewJob) => Promise<boolean> {
  return async (job) => {
    const queued = await deps.store.enqueueJob(job)
    if (!queued) return false
    try {
      await runJob(deps, queued)
      await deps.store.completeJob(queued.id)
    } catch (error) {
      await deps.store.failJob(queued.id, errorText(error), null)
      throw error
    }
    return true
  }
}
